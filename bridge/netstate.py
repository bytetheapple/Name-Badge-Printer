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


def _nmcli_addresses(device: str) -> str | None:
    """The first IPv4 address on a device, without its prefix."""
    for line in _run(["nmcli", "-t", "-f", "IP4.ADDRESS", "device", "show", device]).splitlines():
        _, _, value = line.partition(":")
        addr = value.strip().split("/")[0]
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
        state = (_via_nmcli() if _have("nmcli") else None) or _fallback()
    except Exception:
        state = {"interfaces": [], "wifi_radio": None}
    _cache = (now, state)
    return state
