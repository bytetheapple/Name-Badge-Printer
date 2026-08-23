"""Find a Brother QL printer on the local network.

This exists because of one fact established during the hardware recon
(`docs/PRINTER_RECON_QL820NWB.md`): the printer's wired and wireless interfaces
have **different MAC addresses and different node names**, so they take
different DHCP leases. The moment a printer is moved from Ethernet to WiFi its
address changes, and the bridge has no way to reach it again. Rediscovery is
therefore a prerequisite for the WiFi cutover, not a convenience.

Three routes, cheapest first, none of which needs a new dependency:

1. **mDNS.** Brother names each interface `BRN<mac>` (wired) or `BRW<mac>`
   (wireless), and answers to `<node-name>.local`. Raspberry Pi OS resolves
   that through avahi, so a plain `getaddrinfo` finds it. One call, instant.
2. **A subnet sweep** of port 9100, for when mDNS is unavailable — some
   networks block multicast, and some images ship without avahi.
3. **Identification** of whatever the sweep finds: the ARP table gives each
   candidate's MAC, which is exact; the printer's status page is readable
   without logging in and gives the model, which is a useful fallback when the
   MAC is not known in advance.
"""
from __future__ import annotations

import concurrent.futures
import re
import socket
import subprocess
from dataclasses import dataclass

import requests

PRINT_PORT = 9100
STATUS_PAGE = "/general/status.html"


@dataclass
class Found:
    ip: str
    mac: str | None = None
    model: str | None = None
    node_name: str | None = None
    #: How it was located — useful when a support transcript has to explain
    #: why the bridge is talking to a particular address.
    via: str = "sweep"


def node_name_for(mac: str, wireless: bool = True) -> str:
    """Brother's mDNS name for an interface: BRW/BRN plus the bare MAC."""
    bare = re.sub(r"[^0-9a-fA-F]", "", mac).upper()
    return ("BRW" if wireless else "BRN") + bare


def resolve_all(hostname: str, timeout: float = 3.0) -> list[str]:
    """Every IPv4 address a name resolves to, best first.

    Two things make the naive "take the first answer" wrong here, both seen on
    real hardware:

    * A Brother printer advertises a **link-local 169.254 address** alongside
      its DHCP one, and often IPv6 as well. Answering with the link-local
      address sends the bridge somewhere it cannot route to.
    * Answers are **cached**, so a printer that is switched off still resolves.
      Resolution is a hint, never proof — the caller must verify.
    """
    if not hostname.endswith(".local"):
        hostname += ".local"
    original = socket.getdefaulttimeout()
    socket.setdefaulttimeout(timeout)
    try:
        infos = socket.getaddrinfo(hostname, None, socket.AF_INET)
    except OSError:
        return []
    finally:
        socket.setdefaulttimeout(original)

    seen: list[str] = []
    for _, _, _, _, addr in infos:
        ip = addr[0]
        if ip not in seen:
            seen.append(ip)

    here = local_subnet()
    def rank(ip: str) -> tuple[int, int]:
        # Prefer our own subnet; push link-local to the back but keep it, since
        # a directly-cabled printer may legitimately only have one.
        return (0 if here and ip.startswith(here + ".") else 1,
                1 if ip.startswith("169.254.") else 0)

    return sorted(seen, key=rank)


def resolve(hostname: str, timeout: float = 3.0) -> str | None:
    """The best single address for a name, or None."""
    found = resolve_all(hostname, timeout)
    return found[0] if found else None


def local_subnet() -> str | None:
    """The /24 this machine sits on, as a dotted prefix like '192.168.1'."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # No packet is sent; this just asks the routing table which interface
        # would be used, which is how to learn our own address.
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()
    return ip.rsplit(".", 1)[0] if ip.count(".") == 3 else None


def mac_of(ip: str) -> str | None:
    """The MAC for an address, from the ARP table.

    Only meaningful for a host on the same segment, and only after something
    has talked to it — which the sweep has, by the time this is called.
    """
    try:
        with open("/proc/net/arp") as f:            # Linux, including the Pi
            for line in f.readlines()[1:]:
                parts = line.split()
                if len(parts) >= 4 and parts[0] == ip and parts[3] != "00:00:00:00:00:00":
                    return parts[3].lower()
    except OSError:
        pass
    try:
        out = subprocess.run(                        # macOS and BSD
            ["arp", "-n", ip], capture_output=True, text=True, timeout=3
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})", out, re.I)
    if not m:
        return None
    # macOS prints single-digit octets unpadded ("4:f7:..."); normalise.
    return ":".join(p.rjust(2, "0") for p in m.group(1).lower().split(":"))


def _port_open(ip: str, port: int, timeout: float) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def sweep(
    subnet: str | None = None,
    port: int = PRINT_PORT,
    timeout: float = 0.4,
    workers: int = 64,
) -> list[str]:
    """Addresses on the subnet with the print port open."""
    subnet = subnet or local_subnet()
    if not subnet:
        return []
    hosts = [f"{subnet}.{n}" for n in range(1, 255)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = pool.map(lambda h: (h, _port_open(h, port, timeout)), hosts)
    return [ip for ip, open_ in results if open_]


def model_of(ip: str, timeout: float = 3.0) -> str | None:
    """The printer's model, read from its status page.

    That page is readable without logging in, which is what makes this usable
    for identifying a printer nobody has credentials for yet.
    """
    try:
        r = requests.get(f"http://{ip}{STATUS_PAGE}", timeout=timeout)
        r.raise_for_status()
    except requests.RequestException:
        return None
    m = re.search(r"<title>\s*([^<]+?)\s*</title>", r.text, re.I)
    return m.group(1) if m else None


def find_printer(
    *,
    mac: str | None = None,
    node_name: str | None = None,
    subnet: str | None = None,
    model_hint: str = "Brother",
    sweep_timeout: float = 0.4,
) -> Found | None:
    """Locate one printer, preferring the cheap routes.

    Give it the **wireless** MAC read before the cutover and it will normally
    find the printer with a single mDNS lookup. Without a MAC it falls back to
    sweeping and matching on the model name, which is only reliable when there
    is one printer of that model on the network.
    """
    name = node_name or (node_name_for(mac) if mac else None)
    if name:
        # Resolution is only a hint: the records are cached, so a printer that
        # is switched off still answers. Take the first address that actually
        # has the print port open, and otherwise fall through to the sweep.
        for ip in resolve_all(name):
            if _port_open(ip, PRINT_PORT, 1.5):
                return Found(ip=ip, mac=mac, node_name=name, model=model_of(ip), via="mdns")

    wanted = mac.lower() if mac else None
    candidates = sweep(subnet, timeout=sweep_timeout)
    loose: Found | None = None
    for ip in candidates:
        found = Found(ip=ip, mac=mac_of(ip), model=model_of(ip), node_name=name, via="sweep")
        if wanted and found.mac == wanted:
            return found                              # exact: the MAC matches
        if not wanted and found.model and model_hint.lower() in found.model.lower():
            # Remember it, but keep looking for something better.
            loose = loose or found
    return loose


def discover_printers(
    subnet: str | None = None, model_hint: str = "Brother", sweep_timeout: float = 0.4
) -> list[Found]:
    """Every printer of interest on the subnet — for a 'scan and add' screen."""
    out: list[Found] = []
    for ip in sweep(subnet, timeout=sweep_timeout):
        model = model_of(ip)
        if model and model_hint.lower() in model.lower():
            out.append(Found(ip=ip, mac=mac_of(ip), model=model, via="sweep"))
    return out


def main() -> int:
    """Find printers from the command line.

        ./venv/bin/python discover.py                 # list every Brother printer
        ./venv/bin/python discover.py --mac 44:f7:9f:bc:ab:e8
    """
    import argparse
    import sys

    ap = argparse.ArgumentParser(description="Find Brother printers on this network.")
    ap.add_argument("--mac", help="the printer's wireless MAC, from the configuration run")
    ap.add_argument("--subnet", help="dotted /24 prefix, e.g. 192.168.1 (default: this machine's)")
    args = ap.parse_args()

    if args.mac:
        found = find_printer(mac=args.mac, subnet=args.subnet)
        if not found:
            print("not found — is the printer powered on and on this network?", file=sys.stderr)
            return 1
        print(f"{found.ip}  {found.model or ''}  ({found.via})")
        return 0

    printers = discover_printers(subnet=args.subnet)
    if not printers:
        print("no printers found", file=sys.stderr)
        return 1
    for f in printers:
        print(f"{f.ip:16} {f.mac or '?':18} {f.model or '?'}")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
