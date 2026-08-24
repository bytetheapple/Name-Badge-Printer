"""How the bridge talks to Supabase.

Two backends behind one interface:

* ``BridgeApiClient`` — the supported path. Holds only an opaque bridge token
  and talks to the bridge-poll / bridge-complete Edge Functions, which scope
  everything to the one organization that token belongs to.
* ``LegacyClient`` — the original service_role + PostgREST path, kept so a Pi
  can be upgraded and cut over in two separate steps rather than one risky one.
  The service_role key bypasses RLS and would expose every tenant if the device
  were lost, so this path is deprecated and should be retired per device.

Both expose the same two calls:

    poll(printer_reports, discovered) -> Poll
    complete(job_id, ok, error)

``poll`` also carries the heartbeat, and the job it returns is already claimed.
It is the only channel to the server, so a request for a printer scan comes
back on it too.
"""
from dataclasses import dataclass, field

import requests

import config
import db

_TIMEOUT = 15


@dataclass
class Poll:
    """One round trip with the server."""

    config: dict = field(default_factory=dict)
    printers: list = field(default_factory=list)
    job: dict | None = None
    #: The server is asking this bridge to look for printers on its LAN. Only
    #: ever set just after an admin asks, since sweeping continuously would be
    #: pointless and rude to the network.
    scan: bool = False


class BridgeApiClient:
    """Scoped per-device credential. No RLS bypass, one org only."""

    mode = "bridge token"

    def __init__(self, token):
        self._url = f"{config.SUPABASE_URL}/functions/v1"
        self._headers = {"x-bridge-key": token, "Content-Type": "application/json"}

    def _post(self, fn, payload):
        r = requests.post(
            f"{self._url}/{fn}", headers=self._headers, json=payload, timeout=_TIMEOUT
        )
        if r.status_code == 401:
            raise RuntimeError(
                "the bridge token was rejected (unknown or revoked) — "
                "issue a new one in the admin under Print servers"
            )
        r.raise_for_status()
        body = r.json()
        if not body.get("ok"):
            raise RuntimeError(body.get("error", f"{fn} failed"))
        return body

    def poll(self, printer_reports=None, discovered=None):
        body = self._post(
            "bridge-poll",
            {"printers": printer_reports or [], "discovered": discovered or []},
        )
        return Poll(
            config=body.get("config") or {},
            printers=body.get("printers") or [],
            job=body.get("job"),
            scan=bool(body.get("scan")),
        )

    def complete(self, job_id, ok, error=None):
        self._post(
            "bridge-complete",
            {
                "job_id": job_id,
                "status": "printed" if ok else "failed",
                "error": None if ok else str(error)[:500],
            },
        )


class LegacyClient:
    """Deprecated: the project-wide service_role key, which bypasses RLS."""

    mode = "service_role (deprecated)"

    def poll(self, printer_reports=None, discovered=None):
        # The legacy path has no channel for a scan request, and none is worth
        # building: it exists only so an already-deployed Pi can be cut over.
        for report in printer_reports or []:
            printer_id = report.pop("id", None)
            if printer_id:
                db.update_printer(printer_id, report)
        if printer_reports is not None:
            db.update_bridge({"bridge_last_seen": db._now()})

        cfg = db.get_config()
        printers = db.list_printers()

        job = db.get_queued_job()
        if job:
            job = db.claim_job(job["id"], job.get("attempts", 0))
        # The API backend resolves the name server-side; do the same here so the
        # caller never has to care which backend it is talking to.
        if job and job.get("type") != "test" and not job.get("first_name") and job.get("entry_id"):
            entry = db.get_entry(job["entry_id"])
            if entry:
                job = {
                    **job,
                    "first_name": entry.get("first_name"),
                    "last_name": entry.get("last_name"),
                    "pronouns": job.get("pronouns") or entry.get("pronouns"),
                }
        return Poll(config=cfg, printers=printers, job=job)

    def complete(self, job_id, ok, error=None):
        if ok:
            db.finish_job(job_id)
        else:
            db.fail_job(job_id, error)


def make_client():
    """Prefer the scoped token; fall back to service_role only if that is all there is."""
    if config.BRIDGE_TOKEN:
        return BridgeApiClient(config.BRIDGE_TOKEN)
    return LegacyClient()
