"""Joining a wireless network, and getting back off it when that was a mistake.

This is the one thing the product does that can make a print server
unreachable, so the rollback is the part worth pinning. Every check here is a
way that has actually stranded, or nearly stranded, a machine: a passphrase
that does not work, a network that associates but routes nowhere, and a
captive portal that answers everything except us.

    ./venv/bin/python test_netjoin.py
"""
import sys

import netjoin

FAILURES = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


class Done:
    def __init__(self, code=0, out="", err=""):
        self.returncode, self.stdout, self.stderr = code, out, err


ACTIVE = "NAME:TYPE:DEVICE\nOld-WiFi:802-11-wireless:wlan0\n"
ran = []


def fake_run(args, timeout=15.0, stdin_text=None):
    ran.append((tuple(args), stdin_text))
    if args[:1] == ["which"]:
        return Done(0, "/usr/bin/nmcli\n")
    if args[:4] == ["nmcli", "-t", "-f", "NAME,TYPE,DEVICE"]:
        return Done(0, ACTIVE)
    return SCRIPTED.get(tuple(args), Done(0, ""))


netjoin._run = fake_run
netjoin._PROVE_INTERVAL = 0
# Seconds, not minutes: every rollback path below waits this out twice.
netjoin.PROVE_TIMEOUT = 0.01
SCRIPTED = {}

JOIN = ("nmcli", "--ask", "device", "wifi", "connect", "New-WiFi")
RESTORE = ("nmcli", "connection", "up", "Old-WiFi")

print("— it works: joined, and proved reachable —")
ran.clear()
SCRIPTED = {JOIN: Done(0, "Device 'wlan0' successfully activated")}
ok, err = netjoin.join("New-WiFi", "hunter2", lambda: True)
check("reports success", ok is True and err is None, str(err))
check("does not roll back a network that works", RESTORE not in [a for a, _ in ran], str(ran))
# The passphrase goes on stdin, not in argv: anyone on the box can read argv.
check("the passphrase never reaches the command line",
      not any("hunter2" in " ".join(a) for a, _ in ran), str(ran))
check("and is fed on stdin instead",
      any(s and "hunter2" in s for _, s in ran))

print("— a wrong passphrase: nmcli refuses —")
ran.clear()
SCRIPTED = {JOIN: Done(1, "", "Error: Connection activation failed: Secrets were required")}
ok, err = netjoin.join("New-WiFi", "wrong", lambda: True)
check("reports failure", ok is False)
check("quotes what nmcli said", "Secrets were required" in (err or ""), str(err))
check("and never leaks the passphrase into the message", "wrong" not in (err or "").split(), str(err))

print("— it associates but nothing routes: the case that strands servers —")
ran.clear()
SCRIPTED = {JOIN: Done(0, "successfully activated")}
# Reachable again only once the old profile has actually been brought up --
# which is what distinguishes a recovered server from a lost one, and a prove
# that simply always fails cannot tell those apart.
restored = lambda: RESTORE in [a for a, _ in ran]
ok, err = netjoin.join("New-WiFi", "x", restored)
check("reports failure even though nmcli was happy", ok is False, str(err))
check("puts the old network back", restored(), str(ran))
check("and says it returned to the previous network", "put back" in (err or ""), str(err))

print("— rollback that itself fails is said out loud —")
ran.clear()
ok, err = netjoin.join("New-WiFi", "x", lambda: False)
check("does not claim recovery it cannot see", "may need attention on site" in (err or ""), str(err))

print("— a proof that throws counts as no contact, not as success —")
ran.clear()


def explodes():
    raise OSError("network unreachable")


ok, err = netjoin.join("New-WiFi", "x", explodes)
check("treated as unreachable", ok is False)
check("and rolled back", RESTORE in [a for a, _ in ran], str(ran))

print("— nothing to drive it with —")
netjoin._run = lambda args, timeout=15.0, stdin_text=None: Done(1, "", "not found")
ok, err = netjoin.join("New-WiFi", "x", lambda: True)
check("refuses rather than pretending", ok is False and "nmcli" in (err or ""), str(err))

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
