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

def ask(prompt: str) -> None:
    input(f"\n  >>> {prompt}\n      Press Enter when done… ")


def confirm(prompt: str) -> bool:
    return input(f"\n  >>> {prompt} [y/N] ").strip().lower().startswith("y")


def step(n: int, title: str) -> None:
    print(f"\n{'=' * 70}\n {n}. {title}\n{'=' * 70}")


def find_on_lan(subnet: str | None) -> list[discover.Found]:
    print("  scanning for printers…")
    return discover.discover_printers(subnet=subnet)


def wait_for_printers(
    subnet: str | None, timeout: float = 240.0, interval: float = 5.0
) -> list[discover.Found]:
    """Scan until a printer appears, rather than sleeping and hoping.

    How long a reset printer takes to reach the network varies, so a fixed wait
    is either too short to be reliable or longer than it needs to be. Polling
    returns the moment it is actually there.
    """
    deadline = time.monotonic() + timeout
    attempt = 0
    while True:
        attempt += 1
        found = discover.discover_printers(subnet=subnet)
        if found:
            return found
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return []
        print(f"    nothing yet (attempt {attempt}, {int(remaining)}s left)…")
        time.sleep(min(interval, remaining))


FACTORY_RESET_STEPS = """
      On the printer's own screen:

        1.  Menu
        2.  Up / Down  until you reach  Administration
        3.  OK         to enter it
        4.  Up / Down  until you reach  Reset
        5.  OK
        6.  OK         to choose  Factory Reset
        7.  OK         again to confirm

      *** DO NOT POWER THE PRINTER DOWN WHILE IT IS RESETTING. ***
"""

FIRST_RUN_STEPS = """
      The printer then comes up in its first-run setup, asking for a
      language and then a date and time. Work all the way through it:

        - choose the language
        - press OK through the date and time, leaving the defaults
          (they will show 2017 — that is fine, we set the clock later)

      *** This must be finished before the printer is usable. ***

      It will not go away on its own: switching the printer off and on
      returns to the same screen, and until it is done the printer is
      stuck there. Finishing it also overwrites the clock, which is why
      it has to happen now rather than after we configure anything.
"""
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

    # --------------------------------------------------------------- 1. reset
    step(1, "Factory-reset the printer")
    print("  This is required, not optional, and it comes before the Ethernet")
    print("  cable goes in.")
    print()
    print("  A printer that has been used before carries hundreds of settings")
    print("  we have never enumerated. Resetting is the only way to reach a")
    print("  state this tooling has actually been tested against — and if a")
    print("  previous owner changed the web password, it is also the only way")
    print("  back in, since the reset restores the code printed on the back.")
    print(FACTORY_RESET_STEPS)
    ask("Factory-reset the printer now.")

    print(FIRST_RUN_STEPS)
    ask("Work through the language and date/time screens.")

    # -------------------------------------------------------------- 2. connect
    step(2, "Connect it to the wired network")
    print("  A reset printer has no network settings, so it will take an")
    print("  address from Ethernet and become visible here.")
    ask("Plug in the Ethernet cable and make sure the printer is on.")
    print("\n  watching for it (this stops as soon as it appears)…")
    print("  from a factory reset this usually takes around 90 seconds.")

    found = ([discover.Found(ip=args.ip)] if args.ip
             else wait_for_printers(args.subnet))
    if not found:
        print("\n  Nothing found. Worth checking:")
        print("    - the cable and the switch port")
        print("    - that the printer and this machine are on the same network")
        print("    - that the reset finished (it takes a while, and must not be")
        print("      interrupted)")
        ask("Check those, then continue to try again.")
        found = wait_for_printers(args.subnet, timeout=120)
        if not found:
            return 1

    # Which one are we working on?
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
    step(3, "Log in and confirm what we are talking to")
    web = pc.PrinterWeb(printer.ip, password)
    try:
        web.login()
    except RuntimeError:
        print("  The printer refused that password. After a factory reset it is")
        print("  the code printed on the back of the printer — if that is what")
        print("  you used, the reset probably did not complete.")
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
        print("\n  ! The wireless interface is already active, which a freshly")
        print("    reset printer should not be. The reset may not have completed.")
        if not confirm("Continue anyway?"):
            return 1

    # ----------------------------------------------------------- 4. configure
    step(4, "Configure it")
    result = pc.configure_printer(
        printer.ip, password, log=lambda m: print(f"  {m}")
    )
    print()
    print(result.transcript())
    if not result.ok:
        print("\n  Some settings did not apply. Stopping here rather than")
        print("  moving it onto WiFi in a half-configured state.")
        return 1

    # ---------------------------------------------------------------- 5. wifi
    step(5, "Join the WiFi network")
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

    # --------------------------------------------------------- 6. power cycle
    step(6, "Power-cycle the printer")
    print("  Use the POWER BUTTON, not the cable. Auto power on does not work")
    print("  while Ethernet is connected, so pulling the cord leaves it off.")
    print()
    print("  Then watch the printer's own screen: the WiFi icon should appear.")
    print("  That icon is the only reliable indicator — the web pages will")
    print("  claim things are fine when they are not.")
    ask("Power-cycle the printer and wait for the WiFi icon (~90s).")

    # ------------------------------------------------------------ 7. rediscover
    step(7, "Find it on the wireless network")
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

    # ------------------------------------------------------------- 8. hand over
    step(8, "Hand it over")
    print("  The printer is on the wireless network and answering there with")
    print("  the Ethernet cable still connected, so there is nothing further")
    print("  to check before it comes out.")
    print()
    print("  Tell whoever is installing it:")
    print("    - unplug the Ethernet cable")
    print("    - unplug the power")
    print("    - move the printer to where it will live and plug the power in")
    print()
    print("  It rejoins the wireless network on its own when it powers up.")

    print(f"\n{'=' * 70}")
    print(" Done.")
    print(f"{'=' * 70}")
    print(f"  {model} serial {serial}")
    print(f"  address        {target.ip}")
    print(f"  wireless MAC   {wireless.mac}")
    print(f"  find it again  ./venv/bin/python discover.py --mac {wireless.mac}")
    print()
    print("  Add this address as the printer's IP in the admin, then queue a")
    print("  test print to confirm the whole path works.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
