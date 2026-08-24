"""Move a QL-820NWB onto WiFi — carefully, and with its state reported.

Separate from `printer_config.py` on purpose: this is the one step that severs
the link it is running over, and it has never yet succeeded on real hardware.
So it reports everything it can see before touching anything, and quotes the
printer's own words when something goes wrong.

    # look, change nothing — run this first
    PRINTER_WEB_PASSWORD=xxxx ./venv/bin/python wifi_setup.py 192.168.1.27 --dry-run

    # then, for real
    PRINTER_WEB_PASSWORD=xxxx PRINTER_WIFI_PASSPHRASE=yyyy \
        ./venv/bin/python wifi_setup.py 192.168.1.27 --ssid "201Gilbert"

Both secrets come from the environment so they stay out of shell history, and
neither is ever printed.
"""
from __future__ import annotations

import os
import re
import sys
import time
from html import unescape

import requests

import printer_config as pc
from printer_config import (
    F_INTERFACE,
    F_PASSPHRASE,
    F_RADIO_ON_POWER,
    PAGE_COMMS,
    PAGE_NETSTATUS,
    PAGE_WIRELESS,
    PrinterWeb,
    _explain,
    _interfaces,
    _redact,
    wifi_changes,
    wireless_active,
)

PAGE_WIRELESS_TCPIP = "/net/wireless/tcpip.html"
#: Kept as a re-export: these moved to printer_config, which is where the rest
#: of the printer's web UI lives, but this module's callers still name them.
PAGE_WIRELESS_SCAN = pc.PAGE_WIRELESS_SCAN
visible_networks = pc.visible_networks


def _text(html: str) -> str:
    """Readable text from a page, for reporting what the printer shows.

    Consecutive separators are collapsed: every tag becomes a pipe, so nested
    markup would otherwise leave runs of them between adjacent cells.
    """
    t = re.sub(r"<[^>]+>", " | ", unescape(html))
    t = re.sub(r"\s+", " ", t)
    return re.sub(r"(?:\|\s*)+", "| ", t).strip()


def select_options(html: str) -> dict[str, list[str]]:
    """Every <select> on a page and the choices it offers.

    The device's own JavaScript rewrites some of these as others change — the
    encryption choices depend on the authentication method, for instance. We do
    not run that JavaScript, so the only way to know which value is meant is to
    read what the page actually offers.
    """
    out: dict[str, list[str]] = {}
    for m in re.finditer(r'<select[^>]*name="([^"]+)"[^>]*>(.*?)</select>', html, re.S | re.I):
        name, inner = m.group(1), m.group(2)
        opts = [
            f"{v}={unescape(t).strip()}" + (" *" if "selected" in attrs else "")
            for attrs, v, t in re.findall(
                r'<option([^>]*)\bvalue="([^"]*)"[^>]*>(.*?)</option>', inner, re.S | re.I
            )
        ]
        out[name] = opts
    return out


def _report(title: str, body: str) -> None:
    print(f"\n--- {title} ---")
    print(body)


def survey(web: PrinterWeb) -> dict:
    """Everything relevant about the printer's networking, changing nothing."""
    wired, wireless = _interfaces(web)
    _report(
        "interfaces",
        f"wired    {wired.node_name or '?':20} {wired.mac or '?':18} "
        f"{'ACTIVE' if wired.active else 'inactive'}\n"
        f"wireless {wireless.node_name or '?':20} {wireless.mac or '?':18} "
        f"{'ACTIVE' if wireless.active else 'inactive'}",
    )

    comms_html = web.get(PAGE_COMMS)
    comms = web.fields_of(PAGE_COMMS)
    _report(
        "communication settings",
        "\n".join(f"{k:8} = {v}" for k, v in _redact(comms).items())
        + "\n\n"
        + "\n".join(f"{k:8} {' | '.join(v)}" for k, v in select_options(comms_html).items())
        + f"\n\n{F_INTERFACE} is the radio's role: 0 = infrastructure/adhoc (client),"
        " 1 = + wireless direct, 2 = wireless direct only"
        + "\n(this page, as shown: " + _text(comms_html)[-300:] + ")",
    )

    try:
        tcpip_html = web.get(PAGE_WIRELESS_TCPIP)
        tcpip = web.fields_of(PAGE_WIRELESS_TCPIP)
        _report(
            "wireless TCP/IP",
            "\n".join(f"{k:8} = {v}" for k, v in _redact(tcpip).items())
            + "\n"
            + "\n".join(f"{k:8} {' | '.join(v)}"
                         for k, v in select_options(tcpip_html).items())
            or "(no fields found — the page may need a different path)",
        )
    except requests.RequestException as e:
        _report("wireless TCP/IP", f"could not read: {e}")
        tcpip = {}

    wl = web.fields_of(PAGE_WIRELESS)
    _report(
        "wireless configuration",
        "\n".join(f"{k:8} = {v}" for k, v in _redact(wl).items()),
    )
    wl_html = web.get(PAGE_WIRELESS)
    opts = select_options(wl_html)
    _report(
        "wireless choices offered (* = currently selected)",
        "\n".join(f"{k:8} {' | '.join(v)}" for k, v in opts.items())
        or "(no selects found)",
    )
    _report("wireless page, as shown", _text(wl_html)[:600])

    # The page's own script is where the auth/encryption coupling lives; naming
    # it lets us go and read it if the combination turns out to matter.
    scripts = re.findall(r'src="([^"]*\.js)"', wl_html)
    if scripts:
        _report("scripts this page loads", "\n".join(scripts))

    return {"wired": wired, "wireless": wireless, "comms": comms, "tcpip": tcpip, "wl": wl}


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Put a QL-820NWB onto WiFi.")
    ap.add_argument("ip", help="the printer's current (wired) address")
    ap.add_argument("--ssid", help="the network to join")
    ap.add_argument("--dry-run", action="store_true", help="report only, change nothing")
    ap.add_argument("--open", action="store_true", help="the network has no passphrase")
    ap.add_argument("--wait", type=int, default=180, help="seconds to wait for the radio")
    args = ap.parse_args()

    password = os.environ.get("PRINTER_WEB_PASSWORD", "")
    if not password:
        print("set PRINTER_WEB_PASSWORD to the code on the back of the printer", file=sys.stderr)
        return 2
    passphrase = os.environ.get("PRINTER_WIFI_PASSPHRASE", "")
    if not args.dry_run and not args.ssid:
        print("give --ssid, or use --dry-run to look without changing anything", file=sys.stderr)
        return 2
    if not args.dry_run and not passphrase and not args.open:
        print("set PRINTER_WIFI_PASSPHRASE, or pass --open for an open network", file=sys.stderr)
        return 2

    web = PrinterWeb(args.ip, password)
    try:
        web.login()
    except (requests.RequestException, RuntimeError) as e:
        print(f"could not log in: {e}", file=sys.stderr)
        return 1
    print(f"logged in to {args.ip}")

    state = survey(web)

    seen = visible_networks(web)
    _report(
        "networks the printer can see",
        "\n".join(f"  {s}" for s in seen) if seen else
        "  (none reported — the scan may need the radio enabled, or the page shape differs)",
    )
    if args.ssid and seen and not any(args.ssid.lower() == s.lower() for s in seen):
        print(f"\n  ! '{args.ssid}' is not in that list. This model is 2.4GHz only,")
        print("    so a 5GHz-only network will never appear. Check the name and band")
        print("    before assuming the passphrase is wrong.")

    if args.dry_run:
        print("\ndry run — nothing was changed.")
        return 0

    # The radio has to be switched on, not merely configured. "Keep current
    # state" leaves a wireless LAN that has never been up exactly where it is.
    if state["comms"].get(F_RADIO_ON_POWER) != "0":
        print("\nturning the wireless LAN on at power-on "
              f"({F_RADIO_ON_POWER}: {state['comms'].get(F_RADIO_ON_POWER)} -> 0) …")
        ok, sent, body = web.submit(PAGE_COMMS, {F_RADIO_ON_POWER: "0"})
        print("  " + ("done" if ok else f"FAILED: {_explain(body)}"))

    changes, drop = wifi_changes(args.ssid, passphrase or None)
    print(f"  encryption: {'AES (WPA2)' if passphrase else 'none (open network)'};"
          f" omitting {', '.join(drop)} as a browser would")

    print(f"\napplying: join '{args.ssid}'"
          + (" with a passphrase" if passphrase else " (open network)"))
    print("the wired link may drop as this applies — that is expected")
    try:
        ok, sent, body = web.submit(PAGE_WIRELESS, changes, drop)
    except requests.RequestException as e:
        print(f"  the connection dropped while applying ({type(e).__name__}) — "
              "which is what happens when the printer switches interfaces")
        ok, sent, body = True, changes, ""

    _report("what was sent", "\n".join(f"{k:8} = {v}" for k, v in _redact(sent).items()))
    if not ok:
        print(f"\nFAILED: {_explain(body)}")
        return 1
    print("\naccepted.")

    # The radio does not come up on its own. B31 is "Network Settings on Power
    # On", so it means exactly what it says: the wireless LAN starts at the
    # next power-up, not now. Confirmed on hardware — the settings applied, the
    # interface stayed inactive, and a power cycle brought it straight up.
    print()
    print("=" * 68)
    print("NOW POWER-CYCLE THE PRINTER. The wireless LAN starts at power-on.")
    print("=" * 68)
    print()
    print("Use the power button. Auto power on does not work while Ethernet is")
    print("connected, so pulling the cord will just leave it off.")
    print("Give it about 90 seconds to come back, and watch for the WiFi icon")
    print("on the printer's own screen — that is the only reliable indicator.")
    print()

    mac = state["wireless"].mac
    if mac:
        import discover
        name = discover.node_name_for(mac)
        print(f"Once the WiFi icon is lit, find it at {name}.local — on a NEW")
        print("address, because the wireless interface takes its own DHCP lease:")
        print()
        print(f"    ./venv/bin/python discover.py --mac {mac}")
        print()
        print("Then set that address as the printer's IP in the admin, and the")
        print("Ethernet cable can come out.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
