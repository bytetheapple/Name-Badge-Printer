"""Ask a printer for its serial over SNMP, the way print managers do.

The web page carries the serial but is login-gated on some firmware, and we
discard the web password after setup -- so the page is not a reliable identity
channel across the fleet. SNMP is: port 161, read community "public" (Brother's
default), no login, routed like any UDP, and it returns the serial and MAC that
every network print tool uses to recognise a device across a DHCP move.

This probe confirms whether SNMP answers on a given printer and what it yields,
with no external library -- it builds a minimal SNMPv1 GET by hand.

    ./venv/bin/python probe_snmp.py 192.168.0.235 192.168.1.46

For each printer it queries a few standard OIDs and prints what came back, so
we can see whether the serial is readable this way on the login-gated printer
too.
"""
from __future__ import annotations

import socket
import struct
import sys

COMMUNITY = b"public"

# Standard OIDs. sysDescr proves SNMP answers at all; the printer-MIB serial is
# the identity we want; ifPhysAddress is the MAC as a fallback.
OIDS = {
    "sysDescr (SNMP works at all)": "1.3.6.1.2.1.1.1.0",
    "sysName": "1.3.6.1.2.1.1.5.0",
    "prtGeneralSerialNumber": "1.3.6.1.2.1.43.5.1.1.17.1",
    "hrDeviceDescr": "1.3.6.1.2.1.25.3.2.1.3.1",
    "ifPhysAddress.1 (MAC)": "1.3.6.1.2.1.2.2.1.6.1",
    "ifPhysAddress.2 (MAC)": "1.3.6.1.2.1.2.2.1.6.2",
}


# --- the smallest BER encoder that will build one GET request ----------------
def _len(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    out = b""
    while n:
        out = bytes([n & 0xFF]) + out
        n >>= 8
    return bytes([0x80 | len(out)]) + out


def _tlv(tag: int, value: bytes) -> bytes:
    return bytes([tag]) + _len(len(value)) + value


def _int(n: int) -> bytes:
    if n == 0:
        return _tlv(0x02, b"\x00")
    out = b""
    x = n
    while x:
        out = bytes([x & 0xFF]) + out
        x >>= 8
    if out[0] & 0x80:  # keep it positive
        out = b"\x00" + out
    return _tlv(0x02, out)


def _oid(dotted: str) -> bytes:
    parts = [int(p) for p in dotted.split(".")]
    body = bytes([40 * parts[0] + parts[1]])
    for arc in parts[2:]:
        if arc < 0x80:
            body += bytes([arc])
            continue
        stack = [arc & 0x7F]
        arc >>= 7
        while arc:
            stack.append((arc & 0x7F) | 0x80)
            arc >>= 7
        body += bytes(reversed(stack))
    return _tlv(0x06, body)


def _get_request(oid: str, request_id: int) -> bytes:
    varbind = _tlv(0x30, _oid(oid) + _tlv(0x05, b""))  # oid + NULL
    varbind_list = _tlv(0x30, varbind)
    pdu = _tlv(0xA0, _int(request_id) + _int(0) + _int(0) + varbind_list)
    return _tlv(0x30, _int(0) + _tlv(0x04, COMMUNITY) + pdu)  # version 0 = v1


# --- just enough decoding to pull the answer's value out ---------------------
def _read_tlv(buf: bytes, i: int):
    tag = buf[i]
    i += 1
    n = buf[i]
    i += 1
    if n & 0x80:
        k = n & 0x7F
        n = int.from_bytes(buf[i : i + k], "big")
        i += k
    return tag, buf[i : i + n], i + n


def _decode_value(resp: bytes) -> str | None:
    """The value of the single varbind in a GET response, as text."""
    try:
        _, seq, _ = _read_tlv(resp, 0)  # message
        # version, community, pdu
        i = 0
        _, _, i = _read_tlv(seq, i)  # version
        _, _, i = _read_tlv(seq, i)  # community
        tag, pdu, _ = _read_tlv(seq, i)
        # request-id, error-status, error-index, varbindlist
        j = 0
        for _ in range(3):
            _, _, j = _read_tlv(pdu, j)
        _, vblist, _ = _read_tlv(pdu, j)
        _, vb, _ = _read_tlv(vblist, 0)
        # oid, value
        k = 0
        _, _, k = _read_tlv(vb, k)
        vtag, val, _ = _read_tlv(vb, k)
    except (IndexError, ValueError):
        return None
    if vtag in (0x05, 0x80, 0x81, 0x82):  # NULL / noSuchObject / endOfMib
        return None
    if vtag == 0x04:  # OCTET STRING -- serial, sysDescr, or a raw MAC
        if len(val) == 6 and not all(32 <= b < 127 for b in val):
            return ":".join(f"{b:02x}" for b in val)  # looks like a MAC
        return val.decode("latin-1", "replace").strip()
    if vtag == 0x06:  # OID
        return "<oid>"
    return val.hex()


def query(ip: str, oid: str, timeout: float = 2.0) -> str | None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.sendto(_get_request(oid, 1), (ip, 161))
        data, _ = s.recvfrom(4096)
    except OSError:
        return None
    finally:
        s.close()
    return _decode_value(data)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: probe_snmp.py <printer-ip> [<printer-ip> ...]", file=sys.stderr)
        return 2
    for ip in argv[1:]:
        print(f"\n======== {ip} (SNMP :161, community 'public') ========")
        answered = False
        for label, oid in OIDS.items():
            val = query(ip, oid)
            if val is not None:
                answered = True
            print(f"  {label:32} {val if val is not None else '(no answer)'}")
        if not answered:
            print("  -> nothing answered. SNMP may be disabled on this printer, or the")
            print("     community is not 'public'. That would rule SNMP out as the identity.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
