"""Offline tests for the four provisioning steps the bridge runs.

Every step here either reaches a printer over HTTP or sweeps a subnet, so none
of it can be exercised on the machine that runs the tests. What matters most is
the failure paths: a step that dies badly leaves an operator standing at a
printer with no idea what to do next, and those are exactly the paths that
never get tried by hand.

    ./venv/bin/python test_provision_task.py
"""
import os
import sys

import requests

FAILURES = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import discover  # noqa: E402
import printer_config as pc  # noqa: E402
import provision_task as pt  # noqa: E402

FOUND = discover.Found(
    ip="10.0.0.5", mac="44:f7:9f:bc:ab:e8", model="Brother QL-820NWB", via="sweep"
)
WIRELESS = pc.Interface(node_name="BRW44F79FBCABE8", mac="44:f7:9f:bc:ab:e8", active=False)
WIRED = pc.Interface(node_name="BRN94DDF8AC3645", mac="94:dd:f8:ac:36:45", active=True)

PASSPHRASE = "s3cr3t-wifi-passphrase"

# The steps poll for up to four minutes of real time. Zero the deadlines so a
# "not found" run makes exactly one attempt and returns, rather than spinning
# for the full timeout, and stub sleep as a belt-and-braces second measure.
pt.DISCOVER_TIMEOUT = 0.0
pt.REDISCOVER_TIMEOUT = 0.0
pt.time.sleep = lambda _s: None

posted: list[tuple[str, dict]] = []


def good_result(ok=True, wireless=WIRELESS):
    r = pc.Result(model="QL-820NWB", serial="X1234", firmware=pc.FIRMWARE_VERIFIED)
    r.wired, r.wireless = WIRED, wireless
    r.steps = [pc.Step("set the clock", ok), pc.Step("set the panel language to English", True)]
    return r


class FakeWeb:
    """A printer that accepts everything, recording what it was sent."""

    radio_on_power = "2"      # "keep current state" — the factory default
    raise_on_wireless = None

    def __init__(self, *a, **k):
        pass

    def login(self):
        pass

    def fields_of(self, path):
        return {pc.F_RADIO_ON_POWER: type(self).radio_on_power}

    def submit(self, path, changes, drop=()):
        posted.append((path, changes))
        if path == pc.PAGE_WIRELESS and type(self).raise_on_wireless:
            raise type(self).raise_on_wireless
        return True, changes, ""


def install(found=(FOUND,), result=None, target=FOUND, web=FakeWeb):
    posted.clear()
    FakeWeb.radio_on_power = "2"
    FakeWeb.raise_on_wireless = None
    pt.discover.discover_printers = lambda subnet=None, **k: list(found)
    pt.discover.find_printer = lambda **k: target
    pt.pc.PrinterWeb = web
    pt.pc.configure_printer = lambda ip, pw, **k: (result or good_result())


BASE = {"subnet": "10.0.0", "wired_ip": "10.0.0.5", "ssid": "Lobby-WiFi",
        "web_password": "aguQreSK", "wifi_passphrase": PASSPHRASE,
        "wireless_mac": WIRELESS.mac}

print("— discover —")
install()
r = pt.run("discover", BASE)
check("succeeds and moves to the choice", r.ok and r.next_state == "select", r.next_state)
check("reports what it found", r.data["candidates"] == [
    {"ip": "10.0.0.5", "mac": "44:f7:9f:bc:ab:e8", "model": "Brother QL-820NWB", "via": "sweep"}])

install(found=())
r = pt.run("discover", BASE)
check("nothing found is a failure, not an empty success", not r.ok)
check("says what to check", "Ethernet cable" in (r.error or ""), r.error or "")
check("does not advance the session", r.next_state == "", r.next_state)

print("— configure —")
install()
r = pt.run("configure", BASE)
check("succeeds and moves to the passphrase check",
      r.ok and r.next_state == "wifi_confirm", r.next_state)
check("records the wireless MAC for the cutover",
      r.data["wireless_mac"] == WIRELESS.mac, str(r.data))
check("keeps the transcript", any("set the clock" in ln for ln in r.log))

install(result=good_result(ok=False))
r = pt.run("configure", BASE)
check("a failed setting stops before WiFi", not r.ok and r.next_state == "")
check("explains why", "half-configured" in (r.error or ""), r.error or "")

# The wireless MAC is the only way to find the printer after the cutover, so a
# printer that does not report one must not be moved onto WiFi at all.
install(result=good_result(wireless=pc.Interface()))
r = pt.run("configure", BASE)
check("no wireless MAC is refused up front", not r.ok)
check("names the firmware it expects", pc.FIRMWARE_VERIFIED in (r.error or ""), r.error or "")


class RefusingWeb(FakeWeb):
    def login(self):
        raise RuntimeError("login refused")


install()
pt.pc.configure_printer = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("login refused"))
r = pt.run("configure", BASE)
check("a refused password is explained in plain words",
      not r.ok and "code printed on the back" in (r.error or ""), r.error or "")

install()
pt.pc.configure_printer = lambda *a, **k: (_ for _ in ()).throw(
    requests.ConnectionError("no route to host"))
r = pt.run("configure", BASE)
check("an unreachable printer names the address",
      not r.ok and "10.0.0.5" in (r.error or ""), r.error or "")

print("— wifi —")
install()
r = pt.run("wifi", BASE)
check("succeeds and hands back to the operator",
      r.ok and r.next_state == "power_cycle", r.next_state)
check("sets the radio to start at power-on",
      any(p == pc.PAGE_COMMS and c.get(pc.F_RADIO_ON_POWER) == "0" for p, c in posted),
      str(posted))
wireless_posts = [c for p, c in posted if p == pc.PAGE_WIRELESS]
check("writes the network", wireless_posts and wireless_posts[0][pc.F_SSID] == "Lobby-WiFi",
      str(wireless_posts))
check("uses WPA2 with AES, not legacy TKIP",
      wireless_posts and wireless_posts[0][pc.F_AUTH] == "3"
      and wireless_posts[0][pc.F_ENCRYPTION] == "4", str(wireless_posts))

# Already set: the extra write is skipped rather than sent every time.
install()
FakeWeb.radio_on_power = "0"
r = pt.run("wifi", BASE)
check("leaves the power-on setting alone when it is already right",
      not any(p == pc.PAGE_COMMS for p, _c in posted), str(posted))

# The wired link dropping as the switch happens is the expected outcome. Read
# as a failure it would strand the operator one step from done, and telling
# them to try again would write the settings twice.
install()
FakeWeb.raise_on_wireless = requests.ConnectionError("connection reset")
r = pt.run("wifi", BASE)
check("a dropped connection is success, not a failure",
      r.ok and r.next_state == "power_cycle", f"{r.ok} {r.next_state} {r.error}")
check("says so in the transcript", any("expected" in ln for ln in r.log), str(r.log))

print("— rediscover —")
install()
r = pt.run("rediscover", BASE)
check("succeeds and finishes", r.ok and r.next_state == "done", r.next_state)
check("records the new address", r.data["wireless_ip"] == "10.0.0.5", str(r.data))

install(target=None)
r = pt.run("rediscover", BASE)
check("not found is a failure", not r.ok)
check("leads with the likely cause — the passphrase",
      "passphrase is almost certainly wrong" in (r.error or ""), r.error or "")
check("mentions the 5GHz trap", "5GHz" in (r.error or ""), r.error or "")

print("— the bridge must survive a bad step —")
install()
pt.discover.discover_printers = lambda **k: (_ for _ in ()).throw(ValueError("boom"))
r = pt.run("discover", BASE)
check("an unexpected error is caught, not raised", not r.ok)
check("and is reported", "ValueError" in (r.error or ""), r.error or "")

r = pt.run("not-a-step", BASE)
check("an unknown step is refused", not r.ok and "unknown" in (r.error or ""))

print("— a step never sees a secret it does not need —")
# Guards the server side of the contract: `discover` runs before the operator
# has been asked for anything, and `rediscover` runs when the passphrase has
# already done its job and should be gone.
install()
for task in ("discover", "rediscover"):
    ctx = {k: v for k, v in BASE.items() if k not in ("web_password", "wifi_passphrase")}
    r = pt.run(task, ctx)
    check(f"{task} works with no secrets at all", r.ok, r.error or "")

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
