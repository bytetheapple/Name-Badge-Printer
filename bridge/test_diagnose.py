"""What an unreachable printer is told to do about it.

Beth El lost a morning to "could not find the printer". The print server knew
its own address and that the printer sat on a different network the whole
time; nothing asked it. These checks pin the four answers apart, because the
wrong one sends somebody to the wrong end of the building.

    ./venv/bin/python test_diagnose.py
"""
import sys

import discover

FAILURES = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


def world(src, ping):
    discover.route_source = lambda ip, port=9: src
    discover.answers_ping = lambda ip, timeout=3.0: ping


print("— no address at all —")
check("says so plainly", "No address" in discover.diagnose(""))

print("— no route in that direction —")
world(None, False)
d = discover.diagnose("192.168.0.40")
check("names it as a routing fault, not a printer fault", "no network route" in d)
check("and does not blame the printer", "not a printer fault" in d, d)

print("— a different network, which is what Beth El was —")
world("192.168.3.113", False)
d = discover.diagnose("192.168.0.40")
check("names both networks", "192.168.3.x" in d and "192.168.0.x" in d, d)
check("says wired and wireless are often separate", "wired drop" in d, d)
check("and gives the action that actually worked", "print server on the printer's network" in d, d)

print("— same network, no reply —")
world("192.168.0.87", False)
d = discover.diagnose("192.168.0.40")
check("does not claim a routing problem", "different network" not in d, d)
check("offers client isolation, which guest WiFi has on", "client isolation" in d, d)

print("— answers ping but not the print port —")
# The distinction that took a morning by hand: packets arrive, the service is
# not up. Never say "different network" here; the network is demonstrably fine.
world("192.168.0.87", True)
d = discover.diagnose("192.168.0.40")
check("says the network is fine", "answers ping" in d, d)
check("points at the printer's own state", "ready display" in d, d)
check("and never mentions networks", "different network" not in d, d)

print("— ping unavailable: say less rather than guess —")
world("192.168.3.113", None)
d = discover.diagnose("192.168.0.40")
check("still names the subnet mismatch", "192.168.0.x" in d, d)
check("but claims nothing about ping", "ping" not in d, d)

print("— a reachable-looking address on our own net, ping unknown —")
world("192.168.0.87", None)
d = discover.diagnose("192.168.0.40")
check("makes no claim about replies", "no reply" not in d, d)

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
