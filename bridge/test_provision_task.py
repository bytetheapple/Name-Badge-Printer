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
    #: The wireless page this printer serves. Defaults to 1.32's numbering;
    #: a test can swap in the captured 1.23 page to check the wizard resolves
    #: names off the page rather than assuming them.
    wireless_page = (
        '<form action="/net/wireless/wireless.html">'
        'Communication Mode<select name="%s"><option value="1">Infrastructure</option></select>'
        'Wireless Network Name (SSID)<input name="%s" value=""/>'
        'Authentication Method<select name="%s"><option value="1">Open System</option></select>'
        'Encryption Mode<select name="%s"><option value="1">None</option></select>'
        'Network Key<input name="%s" value="1"/>'
        'WEP Key1<input type="password" name="%s"/>'
        'WEP Key2<input type="password" name="%s"/>'
        'WEP Key3<input type="password" name="%s"/>'
        'WEP Key4<input type="password" name="%s"/>'
        'Passphrase<input type="password" name="%s"/>'
        '</form>'
    ) % (pc.F_COMM_MODE, pc.F_SSID, pc.F_AUTH, pc.F_ENCRYPTION,
         pc.WEP_FIELDS[0], *pc.WEP_FIELDS[1:], pc.F_PASSPHRASE)

    def __init__(self, *a, **k):
        pass

    def login(self):
        pass

    def get(self, path):
        return type(self).wireless_page

    def fields_of(self, path):
        return {pc.F_RADIO_ON_POWER: type(self).radio_on_power}

    def submit(self, path, changes, drop=()):
        posted.append((path, changes))
        if path == pc.PAGE_WIRELESS and type(self).raise_on_wireless:
            raise type(self).raise_on_wireless
        return True, changes, ""


SEEN = ["Guest-2G", "Lobby WiFi"]


def install(found=(FOUND,), result=None, target=FOUND, web=FakeWeb, networks=None):
    posted.clear()
    FakeWeb.radio_on_power = "2"
    FakeWeb.raise_on_wireless = None
    pt.discover.discover_printers = lambda *a, **k: list(found)
    pt.discover.find_printer = lambda **k: target
    pt.pc.PrinterWeb = web
    pt.pc.configure_printer = lambda ip, pw, **k: (result or good_result())
    pt.pc.visible_networks = lambda w: list(SEEN if networks is None else networks)


BASE = {"subnet": "10.0.0", "wired_ip": "10.0.0.5", "ssid": "Lobby-WiFi",
        "web_password": "test-printer-code", "wifi_passphrase": PASSPHRASE,
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
# A printer that answers a ping can still be missed: the sweep needs port 9100
# open, which a printer still on its first-run screens has not opened. The
# message has to say how much was actually searched and what to do next, or it
# reads as "it did not work".
check("says how many networks were searched",
      "networks searched" in (r.error or ""), r.error or "")
check("names the first-run screens, which hold the print service down",
      "first-run" in (r.error or ""), r.error or "")
check("suggests the same router as the print server",
      "same router" in (r.error or ""), r.error or "")
check("and offers naming the address directly",
      "address directly" in (r.error or ""), r.error or "")
check("does not advance the session", r.next_state == "", r.next_state)

print("— a printer already in service must not be mistaken for a new one —")
# The bug this guards: a printer running for weeks answers a sweep instantly,
# while the one actually being set up is still working through a factory reset.
# Stopping at the first answer returns the wrong printer every time, and the
# step that follows used to reconfigure it without anyone choosing it.
IN_SERVICE = discover.Found(ip="10.0.0.9", mac="aa:bb:cc:dd:ee:ff",
                            model="Brother QL-820NWB", via="sweep")

install(found=(IN_SERVICE,))
r = pt.run("discover", {**BASE, "known_ips": ["10.0.0.9"]})
check("finding only a known printer is a failure", not r.ok)
check("says the new printer has not arrived",
      "already in service" in (r.error or ""), r.error or "")
check("still reports what it saw, so the operator can make sense of it",
      [c["ip"] for c in r.data.get("candidates", [])] == ["10.0.0.9"], str(r.data))
check("does not advance to configure", r.next_state == "", r.next_state)

# With both on the network, the sweep succeeds and hands over both — the
# annotation of which is which happens server-side.
install(found=(IN_SERVICE, FOUND))
r = pt.run("discover", {**BASE, "known_ips": ["10.0.0.9"]})
check("a new printer alongside a known one succeeds", r.ok and r.next_state == "select")
check("both are reported", {c["ip"] for c in r.data["candidates"]} == {"10.0.0.9", "10.0.0.5"},
      str(r.data["candidates"]))
check("the transcript marks the one in service",
      any("already in service" in ln for ln in r.log), str(r.log))

# No known printers at all: unchanged behaviour, the first find wins.
install(found=(FOUND,))
r = pt.run("discover", {**BASE, "known_ips": []})
check("with nothing in service it still returns promptly", r.ok and r.next_state == "select")

print("— configure —")
install()
r = pt.run("configure", BASE)
check("succeeds and moves to the passphrase check",
      r.ok and r.next_state == "wifi_confirm", r.next_state)
check("records the wireless MAC for the cutover",
      r.data["wireless_mac"] == WIRELESS.mac, str(r.data))
check("keeps the transcript", any("set the clock" in ln for ln in r.log))
check("reports the firmware outcome for the fleet record",
      r.data["firmware_outcome"] == {"ok": True, "failed_steps": [], "reason": None},
      str(r.data.get("firmware_outcome")))
check("asks the printer which networks it can see",
      r.data["visible_networks"] == SEEN, str(r.data.get("visible_networks")))

# The survey is a convenience. Losing it must cost the operator a picker, not
# the whole setup — they can still name the network themselves.
install()
pt.pc.visible_networks = lambda w: (_ for _ in ()).throw(RuntimeError("scan page missing"))
r = pt.run("configure", BASE)
check("a failed scan does not fail the step", r.ok and r.next_state == "wifi_confirm",
      f"{r.ok} {r.error}")
check("and reports an empty list rather than nothing",
      r.data["visible_networks"] == [], str(r.data.get("visible_networks")))
check("and says so in the transcript",
      any("named by hand" in ln for ln in r.log), str(r.log))

install(result=good_result(ok=False))
r = pt.run("configure", BASE)
check("a failed setting stops before WiFi", not r.ok and r.next_state == "")
check("explains why", "half-configured" in (r.error or ""), r.error or "")
check("names which step failed, which is the part worth recording",
      r.data["firmware_outcome"] == {"ok": False, "failed_steps": ["set the clock"],
                                     "reason": "rejected"},
      str(r.data.get("firmware_outcome")))
# The fleet record is read across every customer and has no org_id, so what
# reaches it must come from a fixed vocabulary. The error text quotes the
# printer's own page, which can carry the org's network name; that stays on
# the org-scoped session log.
check("the reason is from the fixed vocabulary",
      r.data["firmware_outcome"]["reason"] in pt.FAILURE_REASONS,
      str(r.data["firmware_outcome"]["reason"]))
check("no printer page text reaches the fleet record",
      not any(w in str(r.data["firmware_outcome"]) for w in ("printer said", "Login", "SSID")),
      str(r.data["firmware_outcome"]))

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
      not r.ok and "code on" in (r.error or ""), r.error or "")
check("and names the address, since the code is per printer",
      "10.0.0.5" in (r.error or ""), r.error or "")
check("and sends the operator back to re-enter it",
      r.next_state == "password", r.next_state)

print("— a session dropped part way through is a password problem, not firmware —")
# What happened in the field: login appeared to work, the first write landed,
# and every later one came back as the login page. The operator was shown a
# firmware warning, because that is what the transcript led with.
def refused_result():
    r = pc.Result(model="QL-820NWB", serial="H2G", firmware="1.25")
    r.wired, r.wireless = WIRED, WIRELESS
    r.steps = [
        pc.Step("set the clock", True),
        pc.Step("set the panel language to English", False,
                "the printer returned the login page (the session was not accepted)"),
    ]
    return r

install(result=refused_result())
r = pt.run("configure", BASE)
check("is reported as a failure", not r.ok)
# Loosened from "the word firmware must not appear", which was a proxy for the
# real fault: a transcript that LED with a firmware warning when the cause was
# elsewhere. An unverified version is worth naming — it is the one fact that
# distinguishes a printer nobody has tried from one that is misbehaving — but
# it belongs after the things the operator can act on, and hedged.
check("does not lead with the firmware",
      "firmware" not in (r.error or "").lower().split("logged into")[0],
      r.error or "")
check("names an unverified firmware only as a possibility",
      "may be the reason" in (r.error or ""), r.error or "")
# It must say what it managed to do. The message this replaced said the
# settings "were not applied" while the printer's clock had visibly been set,
# and an operator who can see a change the tool denies making has no reason to
# believe the rest of it.
check("says what did apply",
      "set the clock" in (r.error or ""), r.error or "")
check("says where it stopped",
      "set the panel language to English" in (r.error or ""), r.error or "")
# It must not send the operator back to the password either. Reaching this
# point means login() already accepted it — it verifies against a freshly
# fetched settings page and raises when it is wrong — so the session was
# accepted and then lost. Telling someone to re-check a code that demonstrably
# worked sends them to the one place the answer is not.
check("says the password was accepted, not that it was wrong",
      "accepted the password" in (r.error or ""), r.error or "")
check("points at the likely cause instead",
      "logged into" in (r.error or ""), r.error or "")
check("returns to the code, not to the choice of printer",
      r.next_state == "password", r.next_state)
# The whole point of separating these: a mistyped password is not a property of
# the firmware, and counting it as one would make the fleet record misleading.
# Reversed deliberately. A refusal is not an operator's typo — login() proves
# the password before any of this — so it is a fact about the printer, and
# "every device on this firmware drops the session" is precisely what the
# fleet record is for. Discarding it guaranteed nobody would ever see it.
check("and the firmware outcome is recorded, not discarded",
      "firmware_outcome" in r.data, str(r.data))
check("a Result knows it was refused", refused_result().refused is True)
check("an ordinary failure is not mistaken for one",
      good_result(ok=False).refused is False)

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

print("— the wizard posts wifi under the names THIS printer uses —")
# The wizard reaches the wireless page through _wifi(), not through
# configure_printer(), so the field-name lookup has to be here too. Without
# it, a 1.23 printer is sent 1.32's names and rejects the write — which is
# exactly what happened in the field, and what the fix to configure_printer
# alone would NOT have corrected.
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "testdata", "wireless_fw1.23.html"), encoding="utf-8") as fh:
    FakeWeb.wireless_page = fh.read()
posted.clear()
install()
r = pt.run("wifi", {**BASE, "ssid": "Lobby WiFi", "wifi_passphrase": "hunter2"})
check("the wifi step succeeds on 1.23", r.ok, r.error or "")
_wifi_post = next((c for p_, c in posted if p_ == pc.PAGE_WIRELESS), {})
check("sends the SSID as Bdc, this firmware's name",
      _wifi_post.get("Bdc") == "Lobby WiFi", repr(_wifi_post))
check("sends the passphrase as Bf6, not Bf8",
      _wifi_post.get("Bf6") == "hunter2" and "Bf8" not in _wifi_post,
      repr(sorted(_wifi_post)))
check("still uses WPA2 with AES", (_wifi_post.get("B63"), _wifi_post.get("B64")) == ("3", "4"))
# The transcript is sent to the server and shown in the console. It must not
# carry the network key under any firmware's name for it.
check("the passphrase is not in the transcript",
      not any("hunter2" in line for line in (r.log or [])),
      repr(r.log))

print("— discovery says when a printer sits on another network —")
# It is reachable: the sweep only returns addresses whose print port answered.
# The point is that it works *because this site routes between the two*, which
# is exactly the assumption that failed at Beth El once a printer moved to WiFi.
_saved = (discover.local_subnet, pt._wait_for_printers)


class _F:
    def __init__(self, ip):
        self.ip, self.mac, self.model = ip, None, "QL-820NWB"
        self.via, self.name = "sweep", None


try:
    discover.local_subnet = lambda: "192.168.3"
    pt._wait_for_printers = lambda subnet, timeout, say, known=(): [_F("192.168.0.40")]
    r = pt.run("discover", {"subnet": "192.168.3"})
    joined = " ".join(r.log or [])
    check("notes both networks", "192.168.3.x" in joined and "192.168.0.x" in joined, joined)
    check("does not call it a failure", r.ok is True, str(r.error))

    # Same network: nothing to warn about, and a note that always fires is a
    # note nobody reads.
    pt._wait_for_printers = lambda subnet, timeout, say, known=(): [_F("192.168.3.40")]
    r = pt.run("discover", {"subnet": "192.168.3"})
    check("stays quiet when they share a network",
          "note:" not in " ".join(r.log or []), " ".join(r.log or []))
finally:
    discover.local_subnet, pt._wait_for_printers = _saved

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
