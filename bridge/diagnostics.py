"""Connectivity probing: measure the paths the bridge actually uses.

Debugging a flaky site used to mean hand-running ping and `nc` loops over SSH
and reconciling ICMP against TCP by eye — a long evening at one customer proved
how slow that is, and that the fault was the Wi-Fi link, not the printers. This
runs the same tests continuously, off the heartbeat, and feeds two things:

  * cloud — an HTTPS request to Supabase: is the check-in path up, and how slow?
  * ping  — ICMP ping to each printer: does the network reach it at all?
  * tcp   — TCP connect to each printer's print port (9100): will it take a badge?

Two outputs from one probe loop, so a printer sees a single connect per round
whatever is watching:

  * Always: a rolling **transition** record. Each link is tracked with a short
    debounce (down after a few consecutive failures, up on the first success);
    when a link recovers, one outage {kind, started_at, ended_at} is emitted,
    exactly like device_outages. A healthy link emits nothing. This is what the
    ops Connectivity page reads back as history — so an intermittent fault is
    caught without anyone watching live.
  * During an operator's on-demand Link Debug window (printer_status.
    diagnostics_until, handed to us in the poll config): the same probes are
    also emitted as **dense samples** for the live timeline — unchanged.

Runs on its own daemon thread (one instance, started once), modelled on
rehome.Rehomer, so these probes never block the heartbeat.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone

import requests

import discover
import printer

#: How often to run one round of probes. Both ping and 9100 go every round; the
#: round is the unit of "one connect per printer," so this is the printer-facing
#: cadence (5s — the operator's choice; low enough to catch short flaps, high
#: enough to be nothing on the customer's network).
_INTERVAL = 5.0

#: How often the worker wakes to check whether a round is due. Well under
#: _INTERVAL.
_TICK = 1.0

#: Consecutive failed probes before a link counts as "down". A single dropped
#: ping is a blip, not an outage — this debounce (≈15s at the 5s cadence) keeps
#: a genuinely flaky link from writing a row for every missed probe. Mirrors the
#: spirit of device_outages' 2-minute gate, tuned to this probe interval.
_DOWN_AFTER = 3

#: Cloud probe timeout. A real check-in uses a longer timeout, but for the record
#: a slow cloud is as good as a down one — we want to see the outage.
_CLOUD_TIMEOUT = 5.0

#: Don't let pending work pile up unbounded if the main loop stops draining.
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
    """Probes every link continuously, off the loop, emitting transitions always
    and dense samples only while an operator's diagnostics window is open.

    The main loop calls configure() each poll with the current window and
    printers, drain() to collect dense samples, and drain_transitions() to
    collect outage records. Everything shared is guarded by one lock, like
    rehome.Rehomer.
    """

    def __init__(self, supabase_url: str):
        self._cloud_url = (supabase_url or "").rstrip("/")
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._until: datetime | None = None
        self._printers: list[dict] = []
        self._samples: list[dict] = []
        self._transitions: list[dict] = []
        #: Per-link debounce state, keyed by (kind, printer_id|None). Each value
        #: is {"fails": int, "down": bool, "first_fail": datetime|None}.
        self._links: dict[tuple, dict] = {}
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
        valid = {p["id"] for p in snap}
        with self._lock:
            self._until = until
            self._printers = snap
            # Drop debounce state for printers that are gone, so a removed
            # printer's pending outage does not linger (and cannot be emitted
            # against a printer that no longer exists). The cloud key has no
            # printer and is always kept.
            self._links = {
                k: v for k, v in self._links.items() if k[1] is None or k[1] in valid
            }

    def _active(self) -> bool:
        return self._until is not None and datetime.now(timezone.utc) < self._until

    def drain(self) -> list:
        """Dense samples collected since the last call, consumed on read."""
        with self._lock:
            out, self._samples = self._samples, []
        return out

    def drain_transitions(self) -> list:
        """Outage records (one per link recovery) since the last call."""
        with self._lock:
            out, self._transitions = self._transitions, []
        return out

    # -- the background worker ------------------------------------------------
    def _loop(self) -> None:
        while not self._stop.wait(_TICK):
            try:
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
            active = self._active()
        now_dt = datetime.now(timezone.utc)
        at = now_dt.isoformat()
        samples: list[dict] = []
        transitions: list[dict] = []

        def observe(kind: str, printer_id, ok: bool) -> None:
            """Feed one probe result into the debounce state; record an outage
            on recovery. `kind` here is the outage kind ('cloud'/'ping'/'tcp')."""
            key = (kind, printer_id)
            st = self._links.get(key) or {"fails": 0, "down": False, "first_fail": None}
            if ok:
                if st["down"] and st["first_fail"] is not None:
                    start = st["first_fail"]
                    transitions.append({
                        "kind": kind,
                        "printer_id": printer_id,
                        "started_at": start.isoformat(),
                        "ended_at": at,
                        "seconds": max(0, int((now_dt - start).total_seconds())),
                    })
                self._links[key] = {"fails": 0, "down": False, "first_fail": None}
            else:
                fails = st["fails"] + 1
                self._links[key] = {
                    "fails": fails,
                    "down": st["down"] or fails >= _DOWN_AFTER,
                    "first_fail": st["first_fail"] or now_dt,
                }

        # -- cloud -------------------------------------------------------------
        ok, latency = self._probe_cloud()
        if active:
            samples.append({"at": at, "kind": "cloud", "ok": ok, "latency_ms": latency})

        # -- each printer: ICMP ping, then TCP 9100 ---------------------------
        probed: list[tuple] = []  # (outage_kind, printer_id, ok) to observe under the lock
        probed.append(("cloud", None, ok))
        for p in printers:
            ip = p.get("printer_ip")
            port = p.get("port", 9100)
            if not ip:
                continue
            # ICMP: does the network reach it. Latency carries a little fork
            # overhead (wall-clock around the subprocess) — fine for a trend.
            t0 = time.monotonic()
            pinged = bool(discover.answers_ping(ip))
            if active:
                samples.append({
                    "at": at, "kind": "printer_ping", "printer_id": p["id"],
                    "ok": pinged,
                    "latency_ms": int((time.monotonic() - t0) * 1000) if pinged else None,
                })
            probed.append(("ping", p["id"], pinged))
            # TCP 9100: will it take a badge. A clean connect time here is precise.
            t0 = time.monotonic()
            reachable = bool(printer.check_reachable(ip, port))
            if active:
                samples.append({
                    "at": at, "kind": "printer_tcp", "printer_id": p["id"],
                    "ok": reachable,
                    "latency_ms": int((time.monotonic() - t0) * 1000) if reachable else None,
                    "detail": None if reachable else f"no answer on {port}",
                })
            probed.append(("tcp", p["id"], reachable))

        with self._lock:
            for kind, pid, got in probed:
                observe(kind, pid, got)
            if transitions:
                self._transitions.extend(transitions)
                if len(self._transitions) > _MAX_PENDING:
                    self._transitions = self._transitions[-_MAX_PENDING:]
            if samples:
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
