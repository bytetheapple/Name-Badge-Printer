"""Offline tests for printer discovery.

The point of this module is the WiFi cutover: the printer's wired and wireless
interfaces take different DHCP leases, so its address changes and the bridge
has to find it again. These tests cover that without a printer or a network —
the sweep runs against loopback, and mDNS and the ARP table are stubbed.

    ./venv/bin/python test_discover.py
"""
import os
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

FAILURES = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import discover  # noqa: E402

WIRELESS_MAC = "44:f7:9f:bc:ab:e8"

print("— Brother's naming, so a MAC is enough to find the printer —")
check("derives the wireless node name",
      discover.node_name_for(WIRELESS_MAC) == "BRW44F79FBCABE8",
      discover.node_name_for(WIRELESS_MAC))
check("derives the wired node name",
      discover.node_name_for("94-dd-f8-ac-36-45", wireless=False) == "BRN94DDF8AC3645")
check("tolerates whatever separator the page used",
      discover.node_name_for("44f7.9fbc.abe8") == "BRW44F79FBCABE8")

# A stub printer: its status page is readable without logging in, which is what
# makes model identification possible for a printer nobody has credentials for.
class Stub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = b"<html><head><title>Brother QL-820NWB</title></head><body>READY</body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = HTTPServer(("127.0.0.1", 0), Stub)
PORT = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

print("— identifying a printer without credentials —")
check("reads the model from the public status page",
      discover.model_of(f"127.0.0.1:{PORT}") == "Brother QL-820NWB",
      str(discover.model_of(f"127.0.0.1:{PORT}")))
check("returns None for something that is not there", discover.model_of("127.0.0.1:1") is None)

print("— the sweep —")
closed = socket.socket()
closed.bind(("127.0.0.1", 0))
closed_port = closed.getsockname()[1]
closed.close()
check("finds an open port", discover._port_open("127.0.0.1", PORT, 1.0))
check("does not invent a closed one", not discover._port_open("127.0.0.1", closed_port, 0.3))

print("— mDNS answers are ranked, and never trusted on their own —")
real_subnet = discover.local_subnet
discover.local_subnet = lambda: "192.168.1"
real_gai = socket.getaddrinfo
socket.getaddrinfo = lambda host, *a, **k: [
    (socket.AF_INET, 0, 0, "", ("169.254.82.5", 0)),
    (socket.AF_INET, 0, 0, "", ("192.168.1.27", 0)),
]
ranked = discover.resolve_all("BRW44F79FBCABE8")
check("prefers a routable address over link-local",
      ranked[0] == "192.168.1.27", str(ranked))
check("keeps link-local as a last resort", "169.254.82.5" in ranked, str(ranked))
socket.getaddrinfo = real_gai
discover.local_subnet = real_subnet

# A switched-off printer still resolves, because the records are cached.
real_resolve_all = discover.resolve_all
discover.resolve_all = lambda name, timeout=3.0: ["127.0.0.1:1"]
swept = {"n": 0}
real_sweep0 = discover.sweep
discover.sweep = lambda *a, **k: (swept.__setitem__("n", swept["n"] + 1) or [])
found = discover.find_printer(mac=WIRELESS_MAC)
check("does not trust a stale mDNS answer", found is None, str(found))
check("falls through to the sweep when it is stale", swept["n"] == 1)
discover.resolve_all, discover.sweep = real_resolve_all, real_sweep0

print("— mDNS is preferred, and the sweep is the fallback —")
calls = {"resolve": 0, "sweep": 0}
real_resolve, real_sweep, real_mac = discover.resolve_all, discover.sweep, discover.mac_of
# The stub carries its port in the address string, so the reachability check
# that find_printer now performs has to be stubbed alongside it.
real_port_open = discover._port_open
discover._port_open = lambda ip, port, timeout: ip.endswith(str(PORT))

discover.resolve_all = lambda name, timeout=3.0: (calls.__setitem__("resolve", calls["resolve"] + 1)
                                                  or [f"127.0.0.1:{PORT}"])
discover.sweep = lambda *a, **k: (calls.__setitem__("sweep", calls["sweep"] + 1) or [])
found = discover.find_printer(mac=WIRELESS_MAC)
check("finds the printer over mDNS", found is not None and found.via == "mdns", str(found))
check("does not sweep when mDNS answers", calls["sweep"] == 0)
check("still reports the model", found and found.model == "Brother QL-820NWB")

print("— when mDNS is unavailable, the MAC identifies it exactly —")
discover.resolve_all = lambda name, timeout=3.0: []
discover.sweep = lambda *a, **k: [f"127.0.0.1:{PORT}", "127.0.0.1:1"]
discover.mac_of = lambda ip: WIRELESS_MAC if ip.endswith(str(PORT)) else "00:11:22:33:44:55"
found = discover.find_printer(mac=WIRELESS_MAC)
check("falls back to sweeping", found is not None and found.via == "sweep", str(found))
check("matches on the MAC, not the model", found and found.mac == WIRELESS_MAC)

print("— a wrong MAC must not match the wrong printer —")
discover.mac_of = lambda ip: "00:11:22:33:44:55"
found = discover.find_printer(mac=WIRELESS_MAC)
check("returns nothing rather than the wrong device", found is None, str(found))

print("— without a MAC, fall back to the model, which is only a hint —")
found = discover.find_printer(model_hint="Brother")
check("finds a Brother printer", found is not None and found.model == "Brother QL-820NWB")
found = discover.find_printer(model_hint="Zebra")
check("does not match a different make", found is None, str(found))

print("— scan and add —")
listed = discover.discover_printers()
check("lists the printers it found", [f.model for f in listed] == ["Brother QL-820NWB"], str(listed))

discover.resolve_all, discover.sweep, discover.mac_of = real_resolve, real_sweep, real_mac
discover._port_open = real_port_open

print("— the ARP table is parsed, whatever the platform prints —")
check("normalises unpadded octets",
      discover.mac_of("127.0.0.1") in (None, "00:00:00:00:00:00")
      or all(len(p) == 2 for p in discover.mac_of("127.0.0.1").split(":")),
      str(discover.mac_of("127.0.0.1")))

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
