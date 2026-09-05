"""What networks this print server is actually on.

A print server can only reach a printer that is on a network it is also on,
and until now nothing in the product said which those were. At one site the
server sat on a wired 192.168.3.x drop while the printer was on 192.168.0.x
WiFi with no route between them; the app reported "could not find the
printer" and the operator had no way to see the two addresses side by side.

Everything here is best effort and never raises: this is a description for a
status card, and a card that cannot be drawn must not stop a heartbeat.
"""
from __future__ import annotations

import os
import socket
import subprocess
import time

#: Gathering this shells out several times, and it changes when somebody moves
#: a cable. The heartbeat is every fifteen seconds; asking that often would be
#: pure noise.
_TTL = 60.0
_cache: tuple[float, dict] | None = None


def _run(args: list[str], timeout: float = 4.0) -> str:
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout if done.returncode == 0 else ""


def _have(cmd: str) -> bool:
    return bool(_run(["which", cmd]).strip())


def _ipv4(value: str) -> str | None:
    """`value` if it is a dotted IPv4 address, else None.

    nmcli writes an absent field as `--` in some versions and as empty in
    others, and a card reading "--" where an address goes is worse than one
    reading "No address": it looks like a value.
    """
    addr = value.strip().split("/")[0]
    parts = addr.split(".")
    if len(parts) != 4:
        return None
    for part in parts:
        if not part.isdigit() or not 0 <= int(part) <= 255:
            return None
    return addr


def _nmcli_addresses(device: str) -> str | None:
    """The first IPv4 address on a device, without its prefix."""
    for line in _run(["nmcli", "-t", "-f", "IP4.ADDRESS", "device", "show", device]).splitlines():
        _, _, value = line.partition(":")
        addr = _ipv4(value)
        if addr:
            return addr
    return None


def _nmcli_ssid() -> tuple[str | None, int | None]:
    """The SSID this machine is associated with, and its signal."""
    for line in _run(["nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL", "device", "wifi"]).splitlines():
        parts = line.split(":")
        if len(parts) >= 3 and parts[0] == "yes":
            signal = parts[2].strip()
            return (parts[1] or None), (int(signal) if signal.isdigit() else None)
    return None, None


def _via_nmcli() -> dict | None:
    status = _run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status"])
    if not status:
        return None

    radio = _run(["nmcli", "radio", "wifi"]).strip() or None
    ssid, signal = _nmcli_ssid()

    interfaces = []
    for line in status.splitlines():
        parts = line.split(":")
        if len(parts) < 3:
            continue
        device, kind, state = parts[0], parts[1], parts[2]
        if kind not in ("ethernet", "wifi"):
            continue
        entry = {
            "name": device,
            "kind": "wired" if kind == "ethernet" else "wifi",
            "state": state,
            "ip": _nmcli_addresses(device) if state == "connected" else None,
        }
        if kind == "wifi" and state == "connected":
            entry["ssid"] = ssid
            entry["signal"] = signal
        interfaces.append(entry)

    return {"interfaces": interfaces, "wifi_radio": radio}


def _kind_of(device: str) -> str:
    """Wireless or wired, from the kernel rather than from the name.

    By name is wrong: Raspberry Pi OS calls the wired port eth0 on one image
    and end0 on another, and a card that mislabels the two is worse than no
    card, since telling them apart is the entire point.
    """
    return "wifi" if os.path.isdir(f"/sys/class/net/{device}/wireless") else "wired"


def _via_ip() -> dict | None:
    """Interfaces from `ip` and sysfs, for a Linux host with no NetworkManager.

    Raspberry Pi OS only moved to NetworkManager in Bookworm, so a server
    built from an older image has no nmcli at all — and reporting one nameless
    "default" interface for it would hide exactly the wired/wireless
    distinction this exists to show.
    """
    if not os.path.isdir("/sys/class/net"):
        return None
    try:
        devices = sorted(d for d in os.listdir("/sys/class/net") if d != "lo")
    except OSError:
        return None
    if not devices:
        return None

    addresses: dict[str, str] = {}
    for line in _run(["ip", "-o", "-4", "addr", "show"]).splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[2] == "inet":
            addr = _ipv4(parts[3])
            if addr:
                addresses.setdefault(parts[1], addr)

    interfaces = []
    for device in devices:
        kind = _kind_of(device)
        ip = addresses.get(device)
        entry = {
            "name": device,
            "kind": kind,
            "state": "connected" if ip else "no address",
            "ip": ip,
        }
        if kind == "wifi" and ip:
            # iwgetid is not always installed; no SSID is better than a wrong one.
            ssid = _run(["iwgetid", device, "-r"]).strip()
            entry["ssid"] = ssid or None
        interfaces.append(entry)
    return {"interfaces": interfaces, "wifi_radio": None}


def _fallback() -> dict:
    """One interface, no names. Enough for a Mac running a demo bridge.

    Deliberately does not guess at a kind: reporting a wired server as
    wireless would be worse than reporting neither, since the whole point of
    the card is telling those two apart.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except OSError:
        ip = None
    finally:
        s.close()
    return {
        "interfaces": [{"name": "default", "kind": "unknown", "state": "connected", "ip": ip}]
        if ip
        else [],
        "wifi_radio": None,
    }


def describe(max_age: float = _TTL) -> dict:
    """This server's networks, cached. Never raises."""
    global _cache
    now = time.monotonic()
    if _cache and now - _cache[0] < max_age:
        return _cache[1]
    try:
        state = ((_via_nmcli() if _have("nmcli") else None)
                 or _via_ip()
                 or _fallback())
    except Exception:
        state = {"interfaces": [], "wifi_radio": None}
    _cache = (now, state)
    return state
