"""Put this print server onto a wireless network, and undo it if that goes wrong.

The dangerous half of the network feature. Everything here assumes the change
can strand the machine running it: a server that joins a network with no route
to us is a server nobody can reach again without a keyboard and a drive to the
site. So the rule is that no attempt is trusted until the bridge has proved it
can still reach the API, and anything unproved is rolled back.

The passphrase is fed to nmcli on stdin rather than in argv, so it does not
show up in `ps` for every account on the machine while the change is running.
It is never logged, never returned, and never put in an error message.
"""
from __future__ import annotations

import subprocess
import time

#: Long enough for DHCP on a slow network, short enough that a wrong
#: passphrase does not look like a hang.
JOIN_TIMEOUT = 45.0
#: How long the new network gets to prove it can still reach us before the
#: whole thing is reverted.
PROVE_TIMEOUT = 45.0
_PROVE_INTERVAL = 5.0


def _run(args, timeout=15.0, stdin_text=None):
    try:
        return subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, input=stdin_text
        )
    except (OSError, subprocess.SubprocessError) as e:
        return subprocess.CompletedProcess(args, 1, "", str(e))


def available() -> bool:
    """Whether this machine can do any of this at all."""
    return _run(["which", "nmcli"], timeout=5.0).returncode == 0


def active_wifi_profile() -> str | None:
    """The connection profile currently up on a wireless device, if any.

    This is what a rollback goes back to. A server with no wireless profile
    yet has nothing to go back to, which is safe rather than dangerous: the
    fallback is then simply to take the failed one down.
    """
    done = _run(["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"])
    for line in done.stdout.splitlines():
        parts = line.split(":")
        if len(parts) >= 2 and parts[1] in ("802-11-wireless", "wifi"):
            return parts[0]
    return None


def _summarise(done) -> str:
    """nmcli's complaint, trimmed, with nothing of the passphrase in it.

    nmcli does not echo the secret it was given, but this text reaches an
    admin console, so it is capped rather than trusted to be short.
    """
    text = (done.stderr or done.stdout or "").strip().splitlines()
    return (text[-1][:300] if text else "nmcli gave no reason")


def join(ssid: str, passphrase: str, prove, log=lambda m: None) -> tuple[bool, str | None]:
    """Join `ssid`, keeping the old network if the new one cannot reach us.

    `prove` is called with no arguments and returns True when the bridge can
    still talk to the API. It is the only thing that decides success: nmcli
    reporting a successful activation says the radio associated, not that
    anything is reachable through it, and those come apart exactly when a site
    has a captive portal or an isolated guest network.
    """
    if not available():
        return False, "This print server has no nmcli, so its network cannot be set from here."

    previous = active_wifi_profile()
    log(f"joining {ssid}" + (f" (currently on {previous})" if previous else ""))

    # Bring the radio up first. A server that has only ever been wired has it
    # soft-blocked, and nmcli then reports the missing radio as "No network
    # with SSID 'x' found" -- which reads as a typo in the network name and
    # sends whoever is holding the passphrase after the wrong thing. Best
    # effort: if these are absent or refused, the join below says so properly.
    _run(["rfkill", "unblock", "wifi"], timeout=10.0)
    _run(["nmcli", "radio", "wifi", "on"], timeout=10.0)

    done = _run(
        ["nmcli", "--ask", "device", "wifi", "connect", ssid],
        timeout=JOIN_TIMEOUT,
        stdin_text=(passphrase or "") + "\n",
    )
    if done.returncode != 0:
        reason = _summarise(done)
        # The one message worth translating. It is what a blocked radio says,
        # and it is indistinguishable from a mistyped name -- which cost an
        # afternoon at a site with the passphrase in hand the whole time.
        if "no network with ssid" in reason.lower():
            reason += (
                " The name may be wrong, or this server's radio may be blocked "
                "because no WiFi country is set on it."
            )
        log(f"nmcli refused: {reason}")
        # Nothing was activated, so there is nothing to undo -- but the radio
        # may have been left disconnected from what it was on.
        _restore(previous, log)
        return False, f"Could not join {ssid}. {reason}"

    log("associated; checking that this server can still reach us")
    if _prove(prove, log):
        log("reachable on the new network")
        return True, None

    log("no contact on the new network — putting it back")
    _restore(previous, log)
    ok_again = _prove(prove, log)
    if ok_again:
        return False, (
            f"Joined {ssid}, but this print server could not reach the service "
            "through it, so it has been put back on the network it was using. "
            "That usually means the network has no route out, or a sign-in page."
        )
    return False, (
        f"Joined {ssid}, could not reach the service through it, and the "
        "previous network did not come back either. The print server may need "
        "attention on site."
    )


def _prove(prove, log, budget: float | None = None) -> bool:
    # Read at call time, not bound as a default: a default argument is
    # evaluated once when the module loads, which makes the timeout impossible
    # to change and the rollback path impossible to test in under a minute.
    deadline = time.monotonic() + (PROVE_TIMEOUT if budget is None else budget)
    while True:
        try:
            if prove():
                return True
        except Exception as e:  # a check that throws is a check that failed
            log(f"still no contact ({type(e).__name__})")
        if time.monotonic() >= deadline:
            return False
        time.sleep(_PROVE_INTERVAL)


def _restore(previous: str | None, log) -> None:
    """Best effort, always attempted, never raises."""
    if previous:
        log(f"bringing {previous} back up")
        _run(["nmcli", "connection", "up", previous], timeout=JOIN_TIMEOUT)
    else:
        log("no previous wireless network to return to")
