"""Offline tests for probe_printers(): learning a MAC, and following a move.

    ./venv/bin/python test_probe.py
"""
import sys

import bridge
import discover
import printer

FAILURES = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


WIRELESS = "40:5b:d8:25:57:55"
WIRED = "40:5b:d8:25:57:56"

# The printer answers on one address, under the mDNS name built from whichever
# interface it is using.
world = {"reachable": set(), "dns": {}, "arp": {}}


def fake_status(ip, port=9100):
    return {"reachable": ip in world["reachable"], "media_type": "die-cut", "media_width": "62"}


def fake_resolve(name, timeout=3.0):
    return world["dns"].get(name.replace(".local", ""), [])


def fake_mac_of(ip):
    return world["arp"].get(ip)


printer.query_status = fake_status
discover.resolve_all = fake_resolve
discover.mac_of = fake_mac_of
bridge._log = lambda *a, **k: None

P = {"id": "p1", "name": "Lobby", "printer_ip": "192.168.1.50", "port": 9100}

print("— a reachable printer with no MAC recorded gets one —")
world.update(reachable={"192.168.1.50"},
             dns={discover.node_name_for(WIRELESS, True): ["192.168.1.50"]},
             arp={"192.168.1.50": WIRELESS})
r = bridge.probe_printers([dict(P)])[0]
check("reports it reachable", r["reachable"] is True)
check("learns the MAC", r.get("mac") == WIRELESS, str(r))
check("files it as wireless, not wired", "wired_mac" not in r, str(r))
check("does not invent a new address", "printer_ip" not in r, str(r))

print("— the same MAC, but the printer is on Ethernet —")
world.update(dns={discover.node_name_for(WIRED, False): ["192.168.1.50"]},
             arp={"192.168.1.50": WIRED})
r = bridge.probe_printers([dict(P)])[0]
check("files it as wired", r.get("wired_mac") == WIRED, str(r))
check("and not as wireless", "mac" not in r, str(r))

print("— mDNS cannot say which interface it is, so nothing is guessed —")
# Filing a wired MAC under `mac` would be worse than filing nothing: it is
# the value the WiFi recovery searches for and would never find.
world.update(dns={}, arp={"192.168.1.50": WIRELESS})
r = bridge.probe_printers([dict(P)])[0]
check("records no MAC at all", "mac" not in r and "wired_mac" not in r, str(r))

print("— a printer whose lease moved it is followed —")
world.update(reachable={"192.168.1.77"},
             dns={discover.node_name_for(WIRELESS, True): ["192.168.1.77"]},
             arp={})
r = bridge.probe_printers([{**P, "mac": WIRELESS}])[0]
check("finds it at the new address", r.get("printer_ip") == "192.168.1.77", str(r))
check("and reports it reachable, not offline", r["reachable"] is True, str(r))

print("— a printer that is genuinely off stays off —")
world.update(reachable=set(), dns={discover.node_name_for(WIRELESS, True): ["192.168.1.77"]})
r = bridge.probe_printers([{**P, "mac": WIRELESS}])[0]
check("reports unreachable", r["reachable"] is False)
# A cached mDNS record answers for a printer that is switched off, so an
# address that does not accept a connection must not be written to the record.
check("does not move the record to an address that never answered",
      "printer_ip" not in r, str(r))

print("— a printer with no MAC and no answer is simply offline —")
world.update(reachable=set(), dns={}, arp={})
r = bridge.probe_printers([dict(P)])[0]
check("reports unreachable", r["reachable"] is False)
check("nothing else is claimed", set(r) == {"id", "reachable", "media_type",
                                            "media_width", "error_state"}, str(r))

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
