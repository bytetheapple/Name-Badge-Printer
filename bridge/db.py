"""Thin PostgREST client for the print bridge.

Uses the Supabase Data API directly (no supabase-py) with the service_role key,
which bypasses RLS. Kept dependency-light on purpose for a Raspberry Pi.
"""
from datetime import datetime, timezone

import requests

import config

_BASE = f"{config.SUPABASE_URL}/rest/v1"
_HEADERS = {
    "apikey": config.SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {config.SERVICE_ROLE_KEY}",
    "Content-Type": "application/json",
}
_TIMEOUT = 10


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get(path, params):
    r = requests.get(f"{_BASE}/{path}", headers=_HEADERS, params=params, timeout=_TIMEOUT)
    r.raise_for_status()
    return r.json()


def _patch(path, params, body, return_rows=True):
    headers = dict(_HEADERS)
    if return_rows:
        headers["Prefer"] = "return=representation"
    r = requests.patch(
        f"{_BASE}/{path}", headers=headers, params=params, json=body, timeout=_TIMEOUT
    )
    r.raise_for_status()
    return r.json() if return_rows else None


def get_config() -> dict:
    rows = _get("printer_config", {"id": "eq.1", "select": "*"})
    return rows[0] if rows else {}


def get_queued_job():
    rows = _get(
        "print_jobs",
        {"status": "eq.queued", "order": "created_at.asc", "limit": "1", "select": "*"},
    )
    return rows[0] if rows else None


def claim_job(job_id, attempts):
    """Atomically claim a queued job. Returns the row if we won the claim, else None.

    The status=eq.queued filter is the guard: if another worker already moved it
    to 'printing', zero rows match and we get None.
    """
    rows = _patch(
        "print_jobs",
        {"id": f"eq.{job_id}", "status": "eq.queued"},
        {"status": "printing", "claimed_at": _now(), "attempts": attempts + 1},
    )
    return rows[0] if rows else None


def finish_job(job_id):
    _patch(
        "print_jobs",
        {"id": f"eq.{job_id}"},
        {"status": "printed", "printed_at": _now()},
        return_rows=False,
    )


def fail_job(job_id, error):
    _patch(
        "print_jobs",
        {"id": f"eq.{job_id}"},
        {"status": "failed", "error": str(error)[:500]},
        return_rows=False,
    )


def get_entry(entry_id):
    rows = _get("form_entries", {"id": f"eq.{entry_id}", "select": "*"})
    return rows[0] if rows else None


def update_status(fields):
    _patch("printer_status", {"id": "eq.1"}, fields, return_rows=False)
