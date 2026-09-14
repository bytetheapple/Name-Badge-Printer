"""Offline tests for the hand-built SNMP client.

This module is the fleet's identity channel: it reads a printer's serial and
MAC over SNMP, which -- unlike the web page -- needs no login and crosses a
subnet, so it re-finds a printer after a DHCP move even on firmware that gates
the web UI. There is no external SNMP library, so the BER encode/decode is
ours to get right; these tests pin it against bytes captured off a real
QL-820NWB at Shir Hadash, with no printer and no network.

    ./venv/bin/python test_snmp.py
"""
import os
import sys

FAILURES = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import snmp  # noqa: E402


def get_response(oid_dotted, value_tlv, *, error=0):
    """A well-formed SNMP GET-response carrying one varbind, as a printer sends
    it. `value_tlv` is the already-encoded value (OCTET STRING, NULL, ...)."""
    oid = snmp._oid(oid_dotted)
    vb = snmp._tlv(0x30, oid + value_tlv)
    vblist = snmp._tlv(0x30, vb)
    pdu = snmp._tlv(0xA2, snmp._int(1) + snmp._int(error) + snmp._int(0) + vblist)
    return snmp._tlv(0x30, snmp._int(0) + snmp._tlv(0x04, b"public") + pdu)


SERIAL_OID = "1.3.6.1.2.1.43.5.1.1.17.1"

print("— the length encoder spans the short and long forms —")
check("a short length is one byte", snmp._len(9) == b"\x09")
check("0x80 crosses into the long form", snmp._len(0x80) == b"\x81\x80")
check("a two-byte length is tagged 0x82", snmp._len(300) == b"\x82\x01\x2c")

print("— the OID encoder packs the first two arcs and multi-byte arcs —")
# 1.3.6.1.2.1 -> 2b 06 01 02 01 ; the .43 subtree of the printer MIB packs
# a 43 as a single byte, and any arc >= 128 spreads over base-128 groups.
check("the standard prefix packs 1.3 into 0x2b",
      snmp._oid("1.3.6.1.2.1.1.1.0") == bytes.fromhex("06 08 2b 06 01 02 01 01 01 00".replace(" ", "")))
check("an arc over 127 uses base-128 continuation",
      snmp._oid("1.3.6.1.4.1.2435") ==  # Brother's enterprise number, 2435 = 0x93 0x03
      bytes.fromhex("06 07 2b 06 01 04 01 93 03".replace(" ", "")))

print("— a GET request is a complete, re-decodable SNMPv1 message —")
req = snmp._get_request(SERIAL_OID, 1)
check("it is a SEQUENCE", req[0] == 0x30)
check("its declared length matches its body", req[1] == len(req) - 2)
check("the community is 'public'", b"public" in req)

print("— decoding pulls the value out of a real-shaped response —")
serial = get_response(SERIAL_OID, snmp._tlv(0x04, b"H2G205774"))
check("an OCTET STRING serial decodes to text", snmp._decode_value(serial) == "H2G205774")
mac_bytes = bytes.fromhex("405bd8255755")
mac = get_response("1.3.6.1.2.1.2.2.1.6.1", snmp._tlv(0x04, mac_bytes))
check("a six-byte OCTET STRING decodes as a MAC",
      snmp._decode_value(mac) == "40:5b:d8:25:57:55")
# sysDescr is longer than six bytes, so it must stay text even though it, too,
# is an OCTET STRING -- the MAC heuristic is length-gated for exactly this.
descr = get_response("1.3.6.1.2.1.1.1.0", snmp._tlv(0x04, b"Brother NC-38002w"))
check("a longer OCTET STRING is not mistaken for a MAC",
      snmp._decode_value(descr) == "Brother NC-38002w")

print("— an absent value is None, not an exception or a false read —")
absent = get_response(SERIAL_OID, snmp._tlv(0x82, b""))  # noSuchInstance
check("noSuchInstance decodes to None", snmp._decode_value(absent) is None)
check("a NULL value decodes to None",
      snmp._decode_value(get_response(SERIAL_OID, snmp._tlv(0x05, b""))) is None)
check("garbage decodes to None rather than raising",
      snmp._decode_value(b"\x30\x02\xff\xff") is None)

print("— serial() reports the value, and None when there is none —")
_real_query = snmp.query
try:
    snmp.query = lambda ip, oid, timeout=2.0: "H2G205774"
    check("serial() returns what the query yields", snmp.serial("1.2.3.4") == "H2G205774")
    snmp.query = lambda ip, oid, timeout=2.0: None
    check("serial() is None when SNMP does not answer", snmp.serial("1.2.3.4") is None)
    snmp.query = lambda ip, oid, timeout=2.0: ""
    check("an empty string is None, not a blank serial", snmp.serial("1.2.3.4") is None)

    # macs() asks for each interface and keeps the MAC-shaped, de-duplicated.
    answers = {"1.3.6.1.2.1.2.2.1.6.1": "94:dd:f8:ac:36:45",
               "1.3.6.1.2.1.2.2.1.6.2": "40:5b:d8:25:57:55"}
    snmp.query = lambda ip, oid, timeout=2.0: answers.get(oid)
    check("macs() collects every interface's MAC",
          snmp.macs("1.2.3.4") == ["94:dd:f8:ac:36:45", "40:5b:d8:25:57:55"])
    snmp.query = lambda ip, oid, timeout=2.0: "not-a-mac"
    check("macs() drops anything not MAC-shaped", snmp.macs("1.2.3.4") == [])
finally:
    snmp.query = _real_query

print("— a query to nowhere times out to None, it does not raise —")
check("an unreachable host is None",
      snmp.query("192.0.2.1", "1.3.6.1.2.1.1.1.0", timeout=0.2) is None)


print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
