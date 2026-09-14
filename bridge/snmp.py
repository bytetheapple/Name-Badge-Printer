"""Read a printer's identity over SNMP.

Port 161, read community "public" (Brother's default), no login, and routed --
so it works across subnets and, unlike the web page, on the firmware that gates
the web UI. This is how print managers recognise a device across a DHCP move,
and the probe confirmed both Shir Hadash printers answer here including the one
whose web serial is behind a login.

A hand-built SNMPv1 GET, no external library.
"""
from __future__ import annotations

import socket

COMMUNITY = b"public"

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

# The OIDs worth asking for identity.
_SERIAL_OID = "1.3.6.1.2.1.43.5.1.1.17.1"   # prtGeneralSerialNumber
_MAC_OIDS = ("1.3.6.1.2.1.2.2.1.6.1", "1.3.6.1.2.1.2.2.1.6.2")  # ifPhysAddress


def serial(ip: str, timeout: float = 2.0) -> str | None:
    """The printer's serial, or None if SNMP does not answer."""
    v = query(ip, _SERIAL_OID, timeout=timeout)
    return v or None


def macs(ip: str, timeout: float = 2.0) -> list[str]:
    """The interface MACs SNMP reports -- routed, so unlike ARP they are the
    printer's own even across a subnet. Empty when SNMP does not answer."""
    out = []
    for oid in _MAC_OIDS:
        v = query(ip, oid, timeout=timeout)
        if v and ":" in v and v not in out:
            out.append(v)
    return out

