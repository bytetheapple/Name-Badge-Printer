"""On-demand link diagnostics: measure the paths the bridge actually uses.

Debugging a flaky site used to mean hand-running ping and `nc` loops over SSH
and reconciling ICMP against TCP by eye — a long evening at one customer proved
how slow that is. When an operator arms a diagnostics window for an installation
(printer_status.diagnostics_until, handed to us in the poll config), this runs
the same tests the operator was running by hand, every few seconds, and reports
them for the ops Link Debug timeline:

  * cloud        — an HTTPS request to Supabase: is the check-in path up, and how
                   slow? (a timeout/refusal is the "server bounce" seen remotely)
  * printer_ping — ICMP ping to each printer: does the network reach it at all
  * printer_tcp  — TCP connect to each printer's print port (9100): will it
                   actually accept a badge (a printer asleep answers ping but
                   drops 9100 — the exact fault that stumped the site)

It runs on its own daemon thread (one instance, started once), modelled on
rehome.Rehomer, so these probes never block the heartbeat. It is dormant whenever
no window is active, so there is no fleet-wide cost.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone

import requests

import discover
import printer

#: How often to run one round of tests while a window is active. Matches the
#: feel of the operator's manual loops without hammering the printers.
_INTERVAL = 3.0

#: How often the worker wakes to check whether a round is due or the window
#: closed. Well under _INTERVAL.
_TICK = 1.0

#: Cloud probe timeout. A real check-in uses a longer timeout, but for the
#: timeline a slow cloud is as good as a down one — we want to see the spike.
_CLOUD_TIMEOUT = 5.0

#: Don't let samples pile up unbounded if the main loop stops draining.
_MAX_PENDING = 2000


def _parse_until(value) -> datetime | None:
    """A diagnostics-window end as an aware datetime, or None if absent/bad."""
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class DiagnosticsWorker:
    """Runs link tests during an operator's diagnostics window, off the loop.

    The main loop calls configure() each poll with the current window and
    printers, and drain() to collect the samples to report. Everything shared is
    guarded by one lock, like rehome.Rehomer.
    """

    def __init__(self, supabase_url: str):
        self._cloud_url = (supabase_url or "").rstrip("/")
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._until: datetime | None = None
        self._printers: list[dict] = []
        self._samples: list[dict] = []
        self._last_run = 0.0

    # -- lifecycle ------------------------------------------------------------
    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="diagnostics", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    # -- fed by the heartbeat -------------------------------------------------
    def configure(self, diagnostics_until, printers: list) -> None:
        """Adopt the current window and printer list from the poll config."""
        until = _parse_until(diagnostics_until)
        snap = [
            {"id": p["id"], "printer_ip": p.get("printer_ip"), "port": p.get("port", 9100)}
            for p in (printers or [])
        ]
        with self._lock:
            self._until = until
            self._printers = snap

    def _active(self) -> bool:
        return self._until is not None and datetime.now(timezone.utc) < self._until

    def drain(self) -> list:
        """Samples collected since the last call, consumed on read."""
        with self._lock:
            out, self._samples = self._samples, []
        return out

    # -- the background worker ------------------------------------------------
    def _loop(self) -> None:
        while not self._stop.wait(_TICK):
            try:
                with self._lock:
                    active = self._active()
                if not active:
                    continue
                now = time.monotonic()
                if now - self._last_run < _INTERVAL:
                    continue
                self._last_run = now
                self._run_once()
            except Exception:  # noqa: BLE001 — diagnostics must never crash the bridge
                pass

    def _run_once(self) -> None:
        with self._lock:
            printers = list(self._printers)
        at = datetime.now(timezone.utc).isoformat()
        samples: list[dict] = []

        ok, latency = self._probe_cloud()
        samples.append({"at": at, "kind": "cloud", "ok": ok, "latency_ms": latency})

        for p in printers:
            ip = p.get("printer_ip")
            port = p.get("port", 9100)
            if not ip:
                continue
            # ICMP: does the network reach it. Latency is wall-clock around the
            # subprocess, so it carries a little fork overhead — fine for a trend.
            t0 = time.monotonic()
            pinged = discover.answers_ping(ip)
            samples.append({
                "at": at, "kind": "printer_ping", "printer_id": p["id"],
                "ok": bool(pinged),
                "latency_ms": int((time.monotonic() - t0) * 1000) if pinged else None,
            })
            # TCP 9100: will it take a badge. This is the one that matters, and a
            # clean connect time here is precise.
            t0 = time.monotonic()
            reachable = printer.check_reachable(ip, port)
            samples.append({
                "at": at, "kind": "printer_tcp", "printer_id": p["id"],
                "ok": bool(reachable),
                "latency_ms": int((time.monotonic() - t0) * 1000) if reachable else None,
                "detail": None if reachable else f"no answer on {port}",
            })

        with self._lock:
            self._samples.extend(samples)
            if len(self._samples) > _MAX_PENDING:
                self._samples = self._samples[-_MAX_PENDING:]

    def _probe_cloud(self) -> tuple[bool, int | None]:
        """Is the cloud reachable, and how slow. Any HTTP answer (even an error
        status) means the path is up; only a timeout/refusal is a real outage —
        which is exactly the bridge→cloud failure that reads as a server bounce."""
        if not self._cloud_url:
            return False, None
        t0 = time.monotonic()
        try:
            requests.get(self._cloud_url, timeout=_CLOUD_TIMEOUT)
            return True, int((time.monotonic() - t0) * 1000)
        except requests.RequestException:
            return False, None
