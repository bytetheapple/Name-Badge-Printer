"""Walk the whole provisioning script with the network and operator stubbed.

This exists because the first real run died at step 3 on a NameError — a
variable lost in an edit, in a branch nothing had executed. Prompts and network
calls make the script awkward to run, which is exactly why it needs a test that
walks every step without either.

    ./venv/bin/python test_provision.py
"""
import builtins
import os
import sys
import time

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

FOUND = discover.Found(
    ip="10.0.0.5", mac="44:f7:9f:bc:ab:e8", model="Brother QL-820NWB", via="mdns"
)
WIRELESS = pc.Interface(node_name="BRW44F79FBCABE8", mac="44:f7:9f:bc:ab:e8", active=False)
WIRED = pc.Interface(node_name="BRN94DDF8AC3645", mac="94:dd:f8:ac:36:45", active=True)

PASSPHRASE = "s3cr3t-wifi-passphrase"
posted: list[tuple[str, dict]] = []


class FakeWeb:
    def __init__(self, *a, **k):
        pass

    def login(self):
        pass

    def fields_of(self, path):
        return {"B31": "2"}          # radio not yet set to start at power-on

    def submit(self, path, changes, drop=()):
        posted.append((path, dict(changes)))
        return True, dict(changes), ""

    def get(self, path):
        return ""


def install_stubs(found=(FOUND,), wireless=WIRELESS):
    posted.clear()
    discover.discover_printers = lambda **k: list(found)
    discover.find_printer = lambda **k: FOUND
    pc.PrinterWeb = FakeWeb
    pc._identity = lambda web: ("QL-820NWB", "B6G868653", "1.32")
    pc._interfaces = lambda web: (WIRED, wireless)
    pc.configure_printer = lambda ip, pw, **k: pc.Result(
        model="QL-820NWB", serial="B6G868653", firmware="1.32"
    )
    # Echo the prompt: input() normally writes it to stdout, and swallowing it
    # would hide everything the operator is actually told.
    builtins.input = lambda prompt="", *a: (print(prompt), "y")[1]
    time.sleep = lambda *a: None
    os.environ["PRINTER_WEB_PASSWORD"] = "web-pass-do-not-print"
    os.environ["PRINTER_WIFI_PASSPHRASE"] = PASSPHRASE


install_stubs()
sys.argv = ["provision.py", "--ssid", "TestNet"]
import provision  # noqa: E402

# The wait loop is bounded by wall-clock, and `sleep` is stubbed out here — so
# left alone it would spin for its full timeout. The polling itself is trivial;
# what this file is testing is that every step is reachable.
provision.wait_for_printers = lambda subnet, **k: discover.discover_printers(subnet=subnet)

print("— the happy path walks all eight steps —")
import io
import contextlib

buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = provision.main()
out = buf.getvalue()

check("completes successfully", code == 0, f"exit {code}")
for n, title in [
    (1, "Factory-reset"), (2, "Connect it to the wired"), (3, "Log in"),
    (4, "Configure"), (5, "Join the WiFi"), (6, "Power-cycle"),
    (7, "Find it on the wireless"), (8, "Remove the Ethernet"),
]:
    check(f"reaches step {n} ({title.lower()})", f" {n}. {title}" in out, "")

print("— the reset instructions are actually shown —")
for key in ["Menu", "Administration", "Reset", "Factory Reset",
            "DO NOT POWER THE PRINTER DOWN"]:
    check(f"tells the operator about {key!r}", key in out)
check("says the reset comes before Ethernet", "UNPLUGGED" in out)

print("— the wireless steps do the right things —")
paths = [p for p, _ in posted]
check("switches the radio on at power-on",
      any(p == pc.PAGE_COMMS and c.get("B31") == "0" for p, c in posted), str(posted))
check("applies the network after that",
      paths.index(pc.PAGE_WIRELESS) > paths.index(pc.PAGE_COMMS), str(paths))
wifi = [c for p, c in posted if p == pc.PAGE_WIRELESS][0]
check("joins the named network", wifi.get("Bde") == "TestNet")
check("uses WPA/WPA2-PSK with AES", (wifi.get("B63"), wifi.get("B64")) == ("3", "4"))

print("— it does not print the secrets —")
check("the WiFi passphrase never appears", PASSPHRASE not in out)
check("the web password never appears", "web-pass-do-not-print" not in out)

print("— a printer that is still on wireless is questioned —")
install_stubs(wireless=pc.Interface(node_name="BRW…", mac="44:f7:…", active=True))
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    provision.main()
check("warns that a reset printer should not be on WiFi",
      "reset may not have completed" in buf.getvalue())

print("— nothing found means a clear stop, not a crash —")
install_stubs(found=())
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = provision.main()
check("exits non-zero", code == 1, f"exit {code}")
check("suggests what to check", "cable and the switch port" in buf.getvalue())

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
