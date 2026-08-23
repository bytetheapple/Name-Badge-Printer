"""Guided end-to-end provisioning of a printer for a kiosk.

Walks one printer from "just out of a box, possibly second-hand" to "on the
WiFi network, discoverable, ready to print". Every step is confirmed with the
operator, and anything destructive is asked for explicitly.

Run it from any machine on the same network as the printer:

    PRINTER_WEB_PASSWORD=xxxx PRINTER_WIFI_PASSPHRASE=yyyy \
        ./venv/bin/python provision.py --ssid "Lobby-WiFi"

This is deliberately the same code that will run on the Pi later — the bridge
is the only place that can reach a printer on the customer's LAN, so the admin
will drive this remotely by queueing a task the bridge picks up, rather than by
talking to the printer itself.
"""
from __future__ import annotations

import os
import sys
import time

import requests

import discover
import printer_config as pc

RESET_PAGE = "/admin/default.html"
FACTORY_RESET = "6"          # btn_def on the Reset Menu; 2 is network-only


def ask(prompt: str) -> None:
    input(f"\n  >>> {prompt}\n      Press Enter when done… ")


def confirm(prompt: str) -> bool:
    return input(f"\n  >>> {prompt} [y/N] ").strip().lower().startswith("y")


def step(n: int, title: str) -> None:
    print(f"\n{'=' * 70}\n {n}. {title}\n{'=' * 70}")


def find_on_lan(subnet: str | None) -> list[discover.Found]:
    print("  scanning for printers…")
    return discover.discover_printers(subnet=subnet)


def factory_reset(ip: str, password: str) -> bool:
    """Reset a printer we can still reach, so it comes back in a known state.

    A second-hand unit may arrive joined to a network nobody here controls,
    with settings nobody here chose. Resetting is the only way to get to a
    state this tooling has actually been tested against.
    """
    web = pc.PrinterWeb(ip, password)
    try:
        web.login()
    except (requests.RequestException, RuntimeError) as e:
        print(f"  could not log in to reset it: {e}")
        return False
    try:
        web.submit(RESET_PAGE, {"btn_def": FACTORY_RESET})
    except requests.RequestException:
        pass  # it reboots as it resets, so the reply is often lost
    print("  reset requested; the printer will restart.")
    return True


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Provision a printer end to end.")
    ap.add_argument("--ssid", required=True, help="the WiFi network it should join")
    ap.add_argument("--ip", help="skip discovery; use this wired address")
    ap.add_argument("--subnet", help="dotted /24 to scan, e.g. 192.168.1")
    args = ap.parse_args()

    password = os.environ.get("PRINTER_WEB_PASSWORD", "")
    passphrase = os.environ.get("PRINTER_WIFI_PASSPHRASE", "")
    if not password or not passphrase:
        print("set PRINTER_WEB_PASSWORD and PRINTER_WIFI_PASSPHRASE", file=sys.stderr)
        return 2

    print("\nProvisioning a Brother QL-820NWB for kiosk use.")
    print("Nothing is changed without asking first.")

    # ---------------------------------------------------------------- 1. find
    step(1, "Find the printer on the wired network")
    print("  The printer must be connected by Ethernet and powered on.")
    print("  (A second-hand printer may still be on somebody else's WiFi —")
    print("   that is fine, we will reset it.)")
    ask("Connect the Ethernet cable and switch the printer on.")

    found = find_on_lan(args.subnet) if not args.ip else [discover.Found(ip=args.ip)]
    if not found:
        print("\n  No printer found. It may be on a WiFi network we cannot see,")
        print("  or in a state that needs clearing. Factory-reset it by hand:")
        print()
        print("     On the printer: Menu → [Administration] → Reset → Factory Reset")
        print("     (check the model's manual for the exact path — it varies)")
        print()
        print("  A reset printer comes up with no network settings, so it will")
        print("  pick up an address from Ethernet and become visible here.")
        ask("Factory-reset the printer, then wait ~90s for it to come back.")
        found = find_on_lan(args.subnet)
        if not found:
            print("\n  Still nothing. Check the cable, the switch port, and that the")
            print("  printer and this machine are on the same network.")
            return 1

    if len(found) > 1:
        print("\n  More than one printer answered:")
        for i, f in enumerate(found, 1):
            print(f"    {i}. {f.ip:16} {f.mac or '?':18} {f.model or '?'}")
        choice = input("\n  >>> Which one? [1] ").strip() or "1"
        try:
            printer = found[int(choice) - 1]
        except (ValueError, IndexError):
            print("  not a valid choice")
            return 1
    else:
        printer = found[0]
    print(f"\n  Using {printer.ip}" + (f" — {printer.model}" if printer.model else ""))

    # ------------------------------------------------------------- 2. inspect
    step(2, "Check what state it is in")
    web = pc.PrinterWeb(printer.ip, password)
    try:
        web.login()
    except RuntimeError:
        print("  The printer refused that password.")
        print("  On a factory-fresh unit it is the code printed on the back.")
        print("  If this is a second-hand printer, the previous owner may have")
        print("  changed it — a factory reset restores the printed default.")
        return 1
    except requests.RequestException as e:
        print(f"  could not reach it: {e}")
        return 1

    model, serial, firmware = pc._identity(web)
    wired, wireless = pc._interfaces(web)
    print(f"  {model}  serial {serial}  firmware {firmware}")
    print(f"  wired    {wired.node_name} {wired.mac} {'ACTIVE' if wired.active else 'inactive'}")
    print(f"  wireless {wireless.node_name} {wireless.mac} "
          f"{'ACTIVE' if wireless.active else 'inactive'}")
    if firmware != pc.FIRMWARE_VERIFIED:
        print(f"\n  ! This tooling was built against firmware {pc.FIRMWARE_VERIFIED}.")
        print("    Field names may differ. Watch the following steps closely.")

    if wireless.active:
        print("\n  This printer is already on a wireless network — most likely")
        print("  somebody else's. Its settings are unknown to us.")
        if confirm("Factory-reset it so it starts from a known state?"):
            factory_reset(printer.ip, password)
            ask("Wait ~90s for it to restart, then continue.")
            again = find_on_lan(args.subnet)
            if not again:
                print("  It has not come back. Check Ethernet and power.")
                return 1
            printer = again[0]
            web = pc.PrinterWeb(printer.ip, password)
            web.login()
            wired, wireless = pc._interfaces(web)
            print(f"  back at {printer.ip}")

    # ----------------------------------------------------------- 3. configure
    step(3, "Configure it")
    result = pc.configure_printer(
        printer.ip, password, log=lambda m: print(f"  {m}")
    )
    print()
    print(result.transcript())
    if not result.ok:
        print("\n  Some settings did not apply. Stopping here rather than")
        print("  moving it onto WiFi in a half-configured state.")
        return 1

    # ---------------------------------------------------------------- 4. wifi
    step(4, "Join the WiFi network")
    print(f"  Network: {args.ssid}")
    if not confirm("Apply the wireless settings now?"):
        print("  Stopped. Nothing wireless was changed.")
        return 0

    if web.fields_of(pc.PAGE_COMMS).get(pc.F_RADIO_ON_POWER) != "0":
        print("  turning the wireless LAN on at power-on…")
        web.submit(pc.PAGE_COMMS, {pc.F_RADIO_ON_POWER: "0"})

    changes, drop = pc.wifi_changes(args.ssid, passphrase)
    ok, _, body = web.submit(pc.PAGE_WIRELESS, changes, drop)
    if not ok:
        print(f"  FAILED: {pc._explain(body)}")
        return 1
    print("  stored. The radio does not start until the printer restarts.")

    # --------------------------------------------------------- 5. power cycle
    step(5, "Power-cycle the printer")
    print("  Use the POWER BUTTON, not the cable. Auto power on does not work")
    print("  while Ethernet is connected, so pulling the cord leaves it off.")
    print()
    print("  Then watch the printer's own screen: the WiFi icon should appear.")
    print("  That icon is the only reliable indicator — the web pages will")
    print("  claim things are fine when they are not.")
    ask("Power-cycle the printer and wait for the WiFi icon (~90s).")

    # ------------------------------------------------------------ 6. rediscover
    step(6, "Find it on the wireless network")
    print(f"  The wireless interface has its own MAC ({wireless.mac}) and takes")
    print("  its own DHCP lease, so the address will have changed.")
    target = None
    for attempt in range(6):
        target = discover.find_printer(mac=wireless.mac, subnet=args.subnet)
        if target:
            break
        print(f"  not there yet (attempt {attempt + 1}/6)…")
        time.sleep(15)
    if not target:
        print("\n  Not found. Things worth checking, in order:")
        print("    - is the WiFi icon lit on the printer?")
        print("    - is the passphrase right? a wrong one associates then drops")
        print("    - is the network 2.4GHz? this model cannot see 5GHz at all")
        return 1
    print(f"\n  Found at {target.ip} (via {target.via})")

    # ---------------------------------------------------------- 7. unplug
    step(7, "Remove the Ethernet cable")
    print("  The printer is either wired or wireless, never both, so the cable")
    print("  has to come out for it to stay on WiFi.")
    ask("Unplug the Ethernet cable.")

    still = discover.find_printer(mac=wireless.mac, subnet=args.subnet)
    if not still:
        print("\n  It is no longer answering. Give it a moment and re-check with:")
        print(f"    ./venv/bin/python discover.py --mac {wireless.mac}")
        return 1

    print(f"\n{'=' * 70}")
    print(" Done.")
    print(f"{'=' * 70}")
    print(f"  {model} serial {serial}")
    print(f"  address        {still.ip}")
    print(f"  wireless MAC   {wireless.mac}")
    print(f"  find it again  ./venv/bin/python discover.py --mac {wireless.mac}")
    print()
    print("  Add this address as the printer's IP in the admin, then queue a")
    print("  test print to confirm the whole path works.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
