"""Run one step of a provisioning session on the admin's behalf.

`provision.py` is the same walkthrough driven from a terminal, with the
operator answering prompts. Here the operator is in a browser instead, so the
walkthrough is split in two: the physical steps happen there, and the steps
that have to touch the printer happen here, one per poll.

Each call does exactly one step and reports what happened. Nothing is retried
silently and nothing carries state between calls — the session row in the
database is the only memory, which is what lets the operator close the tab
half way through a factory reset and come back to it.

The four steps, in order:

    discover     find printers on the wired network
    configure    log in, identify it, apply the kiosk settings
    wifi         write the wireless settings (the wired link drops)
    rediscover   find it again on the wireless network

Between `configure` and `wifi` the operator confirms the passphrase, and
between `wifi` and `rediscover` they power-cycle the printer. Neither wait
belongs here.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import requests

import discover
import printer_config as pc

#: Steps the bridge runs. Anything else in the session's `state` is waiting on
#: a person and must never reach this module.
TASKS = ("discover", "configure", "wifi", "rediscover")

#: How long each step may take before it gives up and reports back. A factory
#: reset takes around 90 seconds to reach the network and a wireless join a
#: little less, so these are generous rather than tight: reporting "not found"
#: too early sends the operator back to re-check cabling that was always fine.
DISCOVER_TIMEOUT = 240.0
REDISCOVER_TIMEOUT = 150.0
_POLL_INTERVAL = 5.0


@dataclass
class TaskResult:
    """What one step did, in a shape the server can store as-is."""

    ok: bool
    #: The state the session moves to. On failure the server keeps the operator
    #: where they are so the step can be tried again.
    next_state: str = ""
    #: Columns to write back onto the session row.
    data: dict = field(default_factory=dict)
    #: Human-readable account, shown in the admin as the step's transcript.
    log: list[str] = field(default_factory=list)
    error: str | None = None


def _found_json(f) -> dict:
    return {"ip": f.ip, "mac": f.mac, "model": f.model, "via": f.via}


def _wait_for_printers(subnet, timeout, say, known=()) -> list:  # noqa: D417
    """Scan until a printer we do not already know answers.

    How long a reset printer takes to reach the network varies with the switch
    and the DHCP server, so a fixed wait is either unreliable or slower than it
    needs to be.

    `known` is the addresses already in service. Stopping at the first printer
    to answer sounds right and is wrong: a printer that has been running for
    weeks replies instantly, while the one actually being set up is still
    working through a factory reset — so the sweep would return the wrong
    printer, every time, and never even look for the right one.

    Everything found is returned, including the known ones, because the
    operator may still need to see them to understand what is on the network.
    """
    known = {str(ip).strip() for ip in known if ip}
    subnets = discover.candidate_subnets(subnet)
    deadline = time.monotonic() + timeout
    attempt = 0
    seen: list = []
    while True:
        attempt += 1
        found = discover.discover_printers(subnets=subnets)
        if found:
            seen = found
            fresh = [f for f in found if f.ip.strip() not in known]
            if fresh:
                return found
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return seen
        if seen:
            say(f"only printers already in service so far "
                f"(attempt {attempt}, {int(remaining)}s left)")
        else:
            say(f"nothing yet (attempt {attempt}, {int(remaining)}s left)")
        time.sleep(min(_POLL_INTERVAL, remaining))


# --------------------------------------------------------------------- steps


def _discover(ctx, say) -> TaskResult:
    subnet = ctx.get("subnet") or discover.local_subnet()
    known = ctx.get("known_ips") or []
    nets = discover.candidate_subnets(subnet)
    # Wide from the first pass rather than as a fallback. The wait here is for
    # the printer's network stack to come up, not for the sweep — a full pass
    # over every likely range measures at about seven seconds — so searching
    # narrowly first would save nothing and miss a printer one router away.
    say(f"sweeping {len(nets)} networks for printers on port 9100, starting with {nets[0]}.0/24")
    if known:
        say(f"({len(known)} printer(s) already in service will be marked as such)")
    found = _wait_for_printers(subnet, DISCOVER_TIMEOUT, say, known)
    if not found:
        return TaskResult(
            ok=False,
            log=say.lines,
            error=(
                f"No printer answered on any of {len(nets)} networks searched. "
                "The most likely reasons: the printer has not finished its "
                "first-run language and date screens, so its print service is "
                "not listening yet — it answers a ping long before it answers "
                "anything else; or the cable or switch port is at fault. "
                "If neither, plug the printer into the same router or switch as "
                "the print server for the setup — it can move afterwards. "
                "Failing that, enter its address directly."
            ),
        )

    known_set = {str(ip).strip() for ip in known if ip}
    fresh = [f for f in found if f.ip.strip() not in known_set]
    say(f"found {len(found)} printer(s), {len(fresh)} of them new")
    for f in found:
        mark = "" if f.ip.strip() not in known_set else "  (already in service)"
        say(f"  {f.ip}  {f.mac or '?'}  {f.model or '?'}{mark}")
    if not fresh:
        return TaskResult(
            ok=False,
            data={"candidates": [_found_json(f) for f in found]},
            log=say.lines,
            error=(
                f"Only printers already in service answered, across "
                f"{len(nets)} networks. The printer being set up has not "
                "reached the network yet: from a factory reset it takes around "
                "90 seconds, and it must finish its first-run language and date "
                "screens before its print service starts listening. If it has "
                "been longer than that, plug it into the same router or switch "
                "as the print server for the setup — it can move afterwards — "
                "or enter its address directly."
            ),
        )
    return TaskResult(
        ok=True,
        next_state="select",
        data={"candidates": [_found_json(f) for f in found]},
        log=say.lines,
    )


def _applied(result) -> str:
    """What actually took, in the operator's words.

    Said explicitly because the message this replaces claimed nothing had been
    applied while the printer's clock had visibly been set. An operator who can
    see a change the tool says it did not make has no reason to trust the rest
    of what it says.
    """
    done = [st.name for st in result.steps if st.ok]
    if not done:
        return "nothing"
    if len(done) == 1:
        return done[0]
    return ", ".join(done[:-1]) + " and " + done[-1]


def _refusal_advice(result) -> str:
    """What to try, without asserting a cause that is not in evidence.

    The previous text led with "usually something else is logged into that
    printer's web page". That is a guess, and in the field it has been wrong:
    reported with no browser open, and again after a power cycle. Sending an
    operator to close a window that is not open costs them the one thing this
    message is for.

    So: the observation first, then the cheap things to rule out, then the
    thing that is actually diagnostic.
    """
    first_failed = next((st.name for st in result.steps if not st.ok), None)
    where = f"It stopped at \u201c{first_failed}\u201d. " if first_failed else ""
    extra = ""
    if result.firmware and result.firmware != pc.FIRMWARE_VERIFIED:
        extra = (
            f" This printer runs firmware {result.firmware}, which this setup "
            "has not been verified against; that may be the reason."
        )
    return (
        where
        + "If another browser or setup tool is logged into this printer, close "
        "it and try again. If nothing else is talking to it, or a power cycle "
        "made no difference, the printer is ending the session on its own."
        + extra
    )


def _survey(ip: str, password: str, say) -> list[str]:
    """Networks the printer can see. Never raises: this is a convenience."""
    try:
        web = pc.PrinterWeb(ip, password)
        web.login()
        found = pc.visible_networks(web)
    except Exception as e:  # noqa: BLE001 — a failed survey must not fail setup
        say(f"could not read the network scan ({type(e).__name__}); "
            "the network will have to be named by hand")
        return []
    if found:
        say(f"the printer can see {len(found)} network(s): {', '.join(found)}")
    else:
        say("the printer reported no networks it can see")
    return found


def _configure(ctx, say) -> TaskResult:
    ip = ctx.get("wired_ip")
    password = ctx.get("web_password") or ""
    if not ip:
        return TaskResult(ok=False, log=say.lines, error="No printer was chosen.")

    try:
        result = pc.configure_printer(ip, password, log=say)
    except RuntimeError:
        return TaskResult(
            ok=False,
            log=say.lines,
            next_state="password",
            error=(
                f"The printer at {ip} refused that password. It is the code on "
                "that printer's own label — each printer has a different one — "
                "and after a factory reset that is what it expects. If the code "
                "is right, the reset probably did not finish."
            ),
        )
    except requests.RequestException as e:
        return TaskResult(
            ok=False, log=say.lines, error=f"Could not reach the printer at {ip}: {e}"
        )

    say("")
    for line in result.transcript().splitlines():
        say(line)

    data = {
        "model": result.model,
        "serial": result.serial,
        "firmware": result.firmware,
        "wireless_mac": result.wireless.mac,
        # Ask the printer which networks it can see, so the operator picks from
        # a list instead of typing one. It has to be the printer's own survey:
        # this model is 2.4GHz only, so a list from anything else can offer a
        # network it is unable to join — and joining is the step that cannot be
        # undone without another factory reset.
        #
        # Best-effort. An empty list means "no opinion", and the operator names
        # the network themselves, which is what they would have done anyway.
        "visible_networks": _survey(ip, password, say),
        # Fleet-wide record of what this firmware actually does, kept because
        # FIRMWARE_VERIFIED alone cannot tell a version that works from one
        # nobody has tried. Only outcomes the configuration is responsible for
        # are reported: see below for the ones that are not.
        "firmware_outcome": {
            "ok": result.ok,
            "failed_steps": [st.name for st in result.steps if not st.ok],
        },
    }
    if result.refused:
        # The firmware observation is KEPT, which reverses the original
        # reasoning here. That said a refusal was an operator's typo, and that
        # recording it would blame a firmware version for a human mistake. It
        # is not a typo: login() verifies the password against a freshly
        # fetched settings page and raises when it is wrong, so a refusal
        # further in means the password worked and the session did not survive.
        #
        # That is a property of the printer, and one worth having across a
        # fleet — "every device on 1.23 drops the session mid-run" is exactly
        # the pattern firmware_observations exists to make visible, and
        # discarding it guaranteed nobody would ever see it.
        # NOT "wrong password". The password was already proven: login()
        # verifies it against a freshly fetched settings page and raises if it
        # is wrong, so reaching this point means it was accepted and the
        # session was lost afterwards. Telling an operator to re-check a code
        # that demonstrably worked sends them to the one place the answer is
        # not.
        return TaskResult(
            ok=False,
            data=data,
            log=say.lines,
            next_state="password",
            error=(
                f"The printer at {ip} accepted the password, applied "
                f"{_applied(result)}, and then stopped accepting writes — "
                "logging in again did not recover it.\n\n"
                + _refusal_advice(result)
            ),
        )
    if not result.ok:
        return TaskResult(
            ok=False,
            data=data,
            log=say.lines,
            error=(
                "Some settings did not apply. Stopping here rather than moving "
                "the printer onto WiFi half-configured — see the transcript."
            ),
        )
    if not result.wireless.mac:
        # Without it the printer cannot be found again after the cutover, and
        # finding it again is the only proof the WiFi settings worked.
        return TaskResult(
            ok=False,
            data=data,
            log=say.lines,
            error=(
                "The printer did not report a wireless MAC address, so it could "
                "not be found again after moving to WiFi. Check the firmware "
                f"version (this tooling expects {pc.FIRMWARE_VERIFIED})."
            ),
        )
    return TaskResult(ok=True, next_state="wifi_confirm", data=data, log=say.lines)


def _wifi(ctx, say) -> TaskResult:
    ip = ctx.get("wired_ip")
    ssid = ctx.get("ssid")
    password = ctx.get("web_password") or ""
    passphrase = ctx.get("wifi_passphrase") or ""
    if not ip or not ssid:
        return TaskResult(ok=False, log=say.lines, error="No printer or network was chosen.")

    web = pc.PrinterWeb(ip, password)
    try:
        web.login()

        # The catch that cost us an afternoon: the radio can be configured
        # perfectly and still never come up, because "Network Settings on Power
        # On" defaults to keeping whatever the last state was. It only takes
        # effect at the next power-up, which is the very next step.
        if web.fields_of(pc.PAGE_COMMS).get(pc.F_RADIO_ON_POWER) != "0":
            say("turning the wireless LAN on at power-on")
            web.submit(pc.PAGE_COMMS, {pc.F_RADIO_ON_POWER: "0"})

        say(f"writing the settings for {ssid}")
        changes, drop = pc.wifi_changes(ssid, passphrase)
        ok, _sent, body = web.submit(pc.PAGE_WIRELESS, changes, drop)
    except requests.RequestException as e:
        # Losing the connection here is the expected outcome rather than a
        # fault: the printer is either wired or wireless, and it just switched.
        say(f"the wired link dropped while applying, which is expected ({type(e).__name__}: {e})")
        return TaskResult(ok=True, next_state="power_cycle", log=say.lines)
    except RuntimeError as e:
        return TaskResult(ok=False, log=say.lines, error=str(e))

    if not ok:
        return TaskResult(ok=False, log=say.lines, error=pc._explain(body))
    say("stored — the radio does not start until the printer restarts")
    return TaskResult(ok=True, next_state="power_cycle", log=say.lines)


def _rediscover(ctx, say) -> TaskResult:
    mac = ctx.get("wireless_mac")
    subnet = ctx.get("subnet") or discover.local_subnet()
    say(f"looking for the printer on the wireless network ({mac or 'no MAC recorded'})")
    say(f"trying {discover.node_name_for(mac)}.local, then sweeping {subnet}.0/24"
        if mac else f"sweeping {subnet}.0/24")

    deadline = time.monotonic() + REDISCOVER_TIMEOUT
    nets = discover.candidate_subnets(subnet)
    attempt = 0
    target = None
    while True:
        attempt += 1
        # mDNS first — one lookup, and it usually answers. Then the wired
        # network's range, then everywhere else: a printer that joins WiFi
        # frequently lands on a different subnet from the cable it just left.
        target = discover.find_printer(mac=mac, subnet=subnet)
        if not target:
            for net in nets[1:]:
                target = discover.find_printer(mac=mac, subnet=net)
                if target:
                    break
        if target:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        say(f"not there yet (attempt {attempt}, {int(remaining)}s left)")
        time.sleep(min(_POLL_INTERVAL * 3, remaining))

    if not target:
        return TaskResult(
            ok=False,
            log=say.lines,
            error=(
                f"The printer did not appear on any of {len(nets)} networks. "
                "If the WiFi icon "
                "on its screen never became solid, the settings did land and the "
                "network passphrase is almost certainly wrong — this model also "
                "cannot see 5GHz networks at all. If the icon is solid, the "
                "printer is on the network but somewhere this sweep does not "
                "reach: wireless clients often land on a different subnet from "
                "the wired side, and mDNS does not cross one. Read the address "
                "off the printer (Menu -> Information) and enter it directly."
            ),
        )
    say(f"found at {target.ip} (via {target.via})")
    return TaskResult(
        ok=True,
        next_state="done",
        data={"wireless_ip": target.ip},
        log=say.lines,
    )


_STEPS = {
    "discover": _discover,
    "configure": _configure,
    "wifi": _wifi,
    "rediscover": _rediscover,
}


class _Say:
    """Collects the transcript while echoing it to the bridge's own log."""

    def __init__(self, echo=None):
        self.lines: list[str] = []
        self._echo = echo

    def __call__(self, message: str) -> None:
        text = str(message)
        self.lines.append(text)
        if self._echo:
            self._echo(text)


def run(task: str, ctx: dict, log=None) -> TaskResult:
    """Run one step. Never raises — a failure comes back as a TaskResult.

    `ctx` is what the server sent for this step: the session's own columns plus
    whichever secrets the step needs. The caller reports the result on its next
    poll; nothing here writes to the database.
    """
    if task not in _STEPS:
        return TaskResult(ok=False, error=f"unknown provisioning step {task!r}")

    say = _Say(log)
    try:
        return _STEPS[task](ctx, say)
    except Exception as e:  # noqa: BLE001 — a step must not take the bridge down
        say(f"unexpected failure: {type(e).__name__}: {e}")
        return TaskResult(ok=False, log=say.lines, error=f"{type(e).__name__}: {e}")
