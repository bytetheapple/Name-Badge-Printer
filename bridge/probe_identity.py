"""Probe a QL-820NWB for an identity we can match on across DHCP moves.

The question this answers: can the print server read a stable identifier --
serial number, MAC -- from a printer over a plain routed HTTP request, without
the web password (which we discard after setup) and without being on the
printer's own subnet? If yes, recovery after a DHCP reassignment can match on
that identifier instead of on ARP, which only works within one subnet.

Run it on the print server (the Pi), which can reach the printer, against a
printer whose address you know:

    ./venv/bin/python probe_identity.py 192.168.1.27
    ./venv/bin/python probe_identity.py 192.168.1.27 192.168.1.40

It logs in to nothing. It only GETs pages and reports what came back:
  * the model, serial and any MACs it can see, per page;
  * whether a page answered with a login form (i.e. is gated) or with content;
so we can tell which fields are readable unauthenticated and where they live.
"""
from __future__ import annotations

import html
import re
import sys

import requests

# Pages worth asking, cheapest identity first. The status page is the one
# model_of() already reads without logging in; the others are where the recon
# saw a serial and the MACs, and part of the point is to learn whether they
# answer without a password.
PAGES = [
    "/general/status.html",
    "/general/information.html?kind=item",
    "/net/net/net.html",
]

MAC_RE = re.compile(r"\b([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b")
# Brother serials are a letter/digit run, ~8-12 chars, e.g. B6G868653,
# C0Z851372. Matched loosely; the labelled value below is the reliable read.
SERIALISH_RE = re.compile(r"\b[0-9A-Z]{7,14}\b")
TAG_RE = re.compile(r"<[^>]+>")
SCRIPT_STYLE_RE = re.compile(r"<(script|style)\b.*?</\1>", re.I | re.S)


def readable(body: str) -> str:
    """The page as plain text: scripts and tags gone, entities decoded.

    The recon warns that labels are written with numeric entities
    (`Model&#32;Name`), so decoding has to happen before anything is matched.
    """
    body = SCRIPT_STYLE_RE.sub(" ", body)
    body = TAG_RE.sub(" ", body)
    body = html.unescape(body)
    return re.sub(r"[ \t]*\n[ \t\n]*", "\n", re.sub(r"[ \t]+", " ", body)).strip()


def looks_like_login(text: str, body: str) -> bool:
    """Whether this page is the password gate rather than the thing asked for."""
    if 'type="password"' in body.lower():
        return True
    low = text.lower()
    return "login" in low and "password" in low and len(text) < 400


# Words a serial-shaped token might be that are not a serial.
_NOT_SERIAL = {"QL", "MODEL", "SERIAL", "NUMBER", "FIRMWARE", "ETHERNET", "WIRELESS"}


def find_serial(text: str) -> str | None:
    """The serial, found near the word 'Serial' and robust to page layout.

    Brother lays label and value out as separate table cells, which land on
    separate lines once the tags are gone -- but a firmware that keeps them on
    one line ("Serial No. B6G868653") must read the same. So this looks around
    the label for a serial-shaped token rather than trusting the value's exact
    position.
    """
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for i, ln in enumerate(lines):
        if "serial" not in ln.lower():
            continue
        for cand in lines[i : i + 3]:
            for tok in SERIALISH_RE.findall(cand):
                if tok.upper() not in _NOT_SERIAL and any(c.isdigit() for c in tok):
                    return tok
    return None


def labelled_value(text: str, label: str) -> str | None:
    """The value printed after a label, for fields that are not the serial."""
    lines = [ln.strip() for ln in text.splitlines()]
    for i, ln in enumerate(lines):
        if ln.lower().startswith(label.lower()):
            rest = ln[len(label):].strip(" :.\t")
            if rest:
                return rest
            for j in range(i + 1, min(i + 3, len(lines))):
                if lines[j]:
                    return lines[j]
    return None


def probe_page(ip: str, path: str) -> None:
    url = f"http://{ip}{path}"
    print(f"\n--- GET {url}")
    try:
        r = requests.get(url, timeout=5)
    except requests.RequestException as e:
        print(f"    unreachable: {type(e).__name__}: {e}")
        return
    print(f"    HTTP {r.status_code}, {len(r.text)} bytes")
    if r.status_code != 200:
        return

    text = readable(r.text)
    if looks_like_login(text, r.text):
        print("    -> LOGIN PAGE (gated: this field would need the web password)")
        return

    model = labelled_value(text, "Model")
    serial = find_serial(text)
    macs = sorted({m.group(0) for m in MAC_RE.finditer(text)})

    print(f"    model:  {model or '(not found)'}")
    print(f"    serial: {serial or '(not found on this page)'}")
    print(f"    MACs:   {', '.join(macs) if macs else '(none on this page)'}")

    # A short readable dump so we can see any other stable field by eye -- the
    # point of the probe is partly to discover what is there, not only to
    # confirm what we expected.
    excerpt = "\n".join(f"      | {ln}" for ln in text.splitlines() if ln)[:1200]
    print("    page text (trimmed):")
    print(excerpt)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: probe_identity.py <printer-ip> [<printer-ip> ...]", file=sys.stderr)
        return 2
    for ip in argv[1:]:
        print(f"\n======== {ip} ========")
        for path in PAGES:
            probe_page(ip, path)
    print(
        "\nWhat to look for: a serial (or a MAC) on a page that did NOT say "
        "LOGIN PAGE. That field is what recovery can match on across a DHCP "
        "move, no password and no shared subnet needed."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
