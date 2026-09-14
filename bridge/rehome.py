"""Heal a moved printer's address in the background, so recovery is automatic.

The heartbeat already asks mDNS whether an unreachable printer has simply moved
(bridge._relocate), and that quietly fixes the common case. But mDNS does not
cross a subnet, nor a network that blocks multicast -- which is exactly the case
an operator hit at a weekend event: the printer took a DHCP lease on another
subnet, mDNS could not see it, and only a sweep would find it. The sweep is kept
behind the manual "find it again" button on purpose, because sweeping on every
heartbeat, for every printer that is merely switched off, would be a continuous
scan of the customer's network.

This runs that sweep automatically without becoming that scan:

  * on a backoff -- dense in the first minutes after a printer drops, when a
    DHCP move is by far the likeliest reason, then sparse, so a printer off for
    the night is swept a handful of times an hour rather than continuously;
  * on one background thread that never sweeps two printers at once, so the
    print loop is never blocked and the network never sees a burst; and
  * across only the nearest few networks, not the dozen the manual button
    tries -- an unattended sweep should stay a quiet neighbour, while a human
    waiting on the button gets the exhaustive search.

When it finds the printer at a new address it hands that back through take(),
and the heartbeat adopts it exactly as it adopts an mDNS result: the address
heals itself and the printer comes back green with nobody having touched it.
"""
from __future__ import annotations

import threading
import time

import discover

#: Seconds after a printer goes quiet to run each successive sweep. Dense at the
#: front for the DHCP-move case; the tail is capped by _FLOOR so a printer that
#: is genuinely off is retried rarely, not abandoned.
_BACKOFF = (30, 60, 120, 300, 600, 900)
_FLOOR = 1800.0

#: How many of discover.candidate_subnets() an automatic sweep covers. Own
#: subnet plus the nearest neighbours -- enough for the two-routers-in-series
#: move that puts a printer one subnet away, without unattended-scanning a dozen
#: networks. The manual button still sweeps them all.
_AUTO_SUBNETS = 4

#: How often the worker wakes to see whether any printer is due. Well under the
#: shortest backoff, so a due sweep starts promptly; a sweep itself takes far
#: longer than this, so waking often costs nothing.
_TICK = 1.0


def _due_in(attempts: int) -> float:
    """When to sweep next, given how many times we already have."""
    return _BACKOFF[attempts] if attempts < len(_BACKOFF) else _FLOOR


class _Job:
    """One offline printer the background sweep is working on."""

    __slots__ = ("mac", "serial", "subnet", "ip", "attempts", "next_at", "found", "searching")

    def __init__(self, mac, serial, subnet, ip, next_at):
        self.mac = mac
        self.serial = serial
        self.subnet = subnet
        self.ip = ip                 # the address it was last known at, to avoid re-reporting it
        self.attempts = 0
        self.next_at = next_at
        self.found: str | None = None  # a new address waiting for the heartbeat to adopt
        self.searching = False


class Rehomer:
    """Finds moved printers in the background. One instance, started once.

    Fed the reachability of every printer on each heartbeat via update(); the
    heartbeat then asks take() whether a background sweep has turned up a new
    address to try. The sweep itself is injectable so it can be tested without a
    network, and the clock so its schedule can be tested without waiting.
    """

    def __init__(self, search=None, clock=time.monotonic):
        self._search = search or self._sweep
        self._clock = clock
        self._jobs: dict[str, _Job] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # -- lifecycle ------------------------------------------------------------
    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="rehomer", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    # -- fed by the heartbeat -------------------------------------------------
    def update(self, printer: dict, reachable: bool) -> None:
        """Record where a printer stands, so the sweep knows what to look for.

        A printer that is reachable needs no recovery, so its job is dropped --
        which is also how a printer that has just been found stops being swept.
        A printer that is unreachable and has some stable identity (a MAC or a
        serial) to match on gets a job, scheduled after a short grace so a mere
        reboot is not chased.
        """
        pid = printer["id"]
        with self._lock:
            if reachable:
                self._jobs.pop(pid, None)
                return
            mac = printer.get("mac") or printer.get("wired_mac")
            serial = printer.get("serial")
            if not mac and not serial:
                return  # nothing to recognise it by across a move
            job = self._jobs.get(pid)
            if job is None:
                self._jobs[pid] = _Job(
                    mac, serial, printer.get("subnet"), printer.get("printer_ip"),
                    next_at=self._clock() + _due_in(0),
                )
            else:
                # Keep the schedule, refresh what we know it by and where it was.
                job.mac, job.serial = mac, serial
                job.subnet, job.ip = printer.get("subnet"), printer.get("printer_ip")

    def take(self, printer_id: str) -> str | None:
        """A new address a background sweep found for this printer, or None.

        Consumed on read: the heartbeat that takes it verifies it and, if the
        printer really answers there, reports the new address. If it does not,
        the job stays and the next sweep tries again.
        """
        with self._lock:
            job = self._jobs.get(printer_id)
            if job and job.found:
                ip, job.found = job.found, None
                return ip
            return None

    # -- the background worker ------------------------------------------------
    def _loop(self) -> None:
        while not self._stop.wait(_TICK):
            try:
                self._run_once()
            except Exception:  # noqa: BLE001 - recovery must never crash the bridge
                pass

    def _run_once(self) -> None:
        """Sweep for the one printer most overdue, if any is due.

        One per call, so two offline printers are searched on successive ticks
        rather than at once: the promise is that the network never sees two
        sweeps in flight. A job that already has an unclaimed result is skipped
        until the heartbeat takes it, so a find is not overwritten by the next.
        """
        now = self._clock()
        with self._lock:
            due = [
                (pid, j) for pid, j in self._jobs.items()
                if not j.searching and j.found is None and now >= j.next_at
            ]
            if not due:
                return
            pid, job = min(due, key=lambda kv: kv[1].next_at)
            job.searching = True
            snap = (job.mac, job.serial, job.subnet, job.ip)

        found = None
        try:
            found = self._search(*snap)
        except Exception:  # noqa: BLE001 - a failed sweep reschedules, it does not raise
            found = None
        with self._lock:
            job = self._jobs.get(pid)
            if job is not None:
                job.searching = False
                job.attempts += 1
                job.next_at = self._clock() + _due_in(job.attempts)
                if found and found != snap[3]:
                    job.found = found

    def _sweep(self, mac, serial, subnet, ip) -> str | None:
        """The real search: the nearest few networks, cheapest route first.

        discover.find_printer tries mDNS before it sweeps, so a printer that is
        reachable by name is found without a scan even here; the sweep is the
        fallback that crosses the subnet mDNS cannot.
        """
        for net in discover.candidate_subnets(subnet)[:_AUTO_SUBNETS]:
            found = discover.find_printer(mac=mac, serial=serial, subnet=net)
            if found and found.ip and found.ip != ip:
                return found.ip
        return None
