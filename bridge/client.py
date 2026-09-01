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

    poll(printer_reports, provision_result) -> Poll
    complete(job_id, ok, error)

``poll`` also carries the heartbeat, and the job it returns is already claimed.
It is the only channel to the server, so a step of a printer's guided setup
comes back on it too.
"""
from dataclasses import dataclass, field

import socket

import requests

import config
import credential
import db

#: Read once. See the note in poll().
_VERSION = config.running_version()
_HOSTNAME = socket.gethostname()

_TIMEOUT = 15


@dataclass
class Poll:
    """One round trip with the server."""

    config: dict = field(default_factory=dict)
    printers: list = field(default_factory=list)
    job: dict | None = None
    #: One step of a provisioning session for the bridge to run, already claimed
    #: by the server: {session_id, task, …context, …the secrets that step needs}.
    provision: dict | None = None
    #: This poll carried a replacement credential, which has been stored. Worth
    #: a log line and nothing more — the value itself is never logged.
    rotated: bool = False
    #: The organization is suspended. The credential is still good — this is
    #: not a revocation — there is simply no work while it lasts.
    suspended: bool = False


class BridgeApiClient:
    """Scoped per-device credential. No RLS bypass, one org only."""

    mode = "bridge token"

    def __init__(self, token):
        self._url = f"{config.SUPABASE_URL}/functions/v1"
        self._token = token
        self._headers = {"x-bridge-key": token, "Content-Type": "application/json"}
        #: Set when storing a replacement failed, and sent on the next poll so
        #: the server stops minting one every couple of seconds.
        self._rotation_error = None

    def _adopt(self, token):
        """Store a replacement credential and start using it.

        Order matters: the token is made durable on disk *before* it is used,
        because using it is what tells the server to retire the current one. A
        crash between the two would otherwise leave the device holding a
        credential that has just been revoked.
        """
        credential.store(token)      # raises if it cannot be made durable
        self._token = token
        self._headers["x-bridge-key"] = token

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

    def poll(self, printer_reports=None, provision_result=None):
        body = self._post(
            "bridge-poll",
            {
                "printers": printer_reports or [],
                # What this device is actually running, said by the device.
                # The updater also reports a version, but only when it runs —
                # so a fleet whose updater was broken showed no version at all
                # and nobody could tell that from "not reported yet". Read once
                # at import: it cannot change without the service restarting,
                # which is what the updater does after a checkout.
                "version": _VERSION,
                "hostname": _HOSTNAME,
                **({"rotation_error": self._rotation_error} if self._rotation_error else {}),
                # Present only on the poll after a provisioning step finished.
                **({"provision_result": provision_result} if provision_result else {}),
            },
        )
        replacement = body.get("bridge_token")
        adopted = False
        if replacement:
            try:
                self._adopt(replacement)
                self._rotation_error = None
                adopted = True
            except Exception as e:  # noqa: BLE001 — never fatal
                # The credential in hand is still valid: the server does not
                # retire it until the replacement is actually used. Report the
                # failure so it stops offering one, and carry on printing.
                self._rotation_error = f"{type(e).__name__}: {e}"[:200]
        elif self._rotation_error:
            # Reported once; the server has recorded it and backed off.
            self._rotation_error = None

        return Poll(
            config=body.get("config") or {},
            printers=body.get("printers") or [],
            job=body.get("job"),
            provision=body.get("provision"),
            suspended=bool(body.get("suspended")),
            # Whether the credential actually changed, not whether one was
            # offered — a device that could not store it has not rotated, and
            # saying otherwise would put a false line in the log.
            rotated=adopted,
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

    def poll(self, printer_reports=None, provision_result=None):
        # The legacy path has no channel for a provisioning step, and none is
        # worth building: it exists only so an already-deployed Pi can be cut
        # over.
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
    if config.BRIDGE_TOKEN or credential.stored():
        # The stored credential wins: the bootstrap value in .env is retired by
        # the server the first time it is used.
        return BridgeApiClient(credential.current(config.BRIDGE_TOKEN))
    return LegacyClient()
