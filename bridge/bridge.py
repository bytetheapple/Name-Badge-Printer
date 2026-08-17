"""Print bridge main loop.

Polls Supabase for queued print jobs, claims them atomically, renders the badge,
and sends it to the Brother QL-820NWB. Periodically writes a heartbeat + printer
status row so the admin console can show connectivity and media state.

Run from this directory:  python bridge.py
"""
import hashlib
import os
import sys
import time
import traceback
from datetime import datetime, timezone
from io import BytesIO

import requests
from PIL import Image

import config
import db
import printer
from badge import render_badge, render_test_badge

_HEADER_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".header_cache")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log(msg, err=False):
    print(f"[{_now()}] {msg}", file=sys.stderr if err else sys.stdout, flush=True)


def resolve_header(url):
    """Fetch a custom header image URL to a local file and return its path.

    Cached on disk by URL (the URLs are content-addressed, so a changed image
    always has a new URL). Returns None on any failure so the caller falls back
    to the default header — a missing custom graphic never fails a print.
    """
    if not url:
        return None
    try:
        os.makedirs(_HEADER_CACHE, exist_ok=True)
        key = hashlib.sha1(url.encode("utf-8")).hexdigest()
        path = os.path.join(_HEADER_CACHE, f"{key}.img")
        if os.path.exists(path):
            return path
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        Image.open(BytesIO(resp.content)).verify()  # reject non-images (e.g. HTML errors)
        with open(path, "wb") as f:
            f.write(resp.content)
        return path
    except Exception as e:  # noqa: BLE001 - any failure just falls back to default
        _log(f"custom header fetch failed ({url}): {e}", err=True)
        return None


def handle_job(job: dict, cfg: dict):
    job_id = job["id"]
    try:
        template = cfg.get("badge_template") or {}
        label = cfg.get("label_media", "62")

        target = db.get_printer(job.get("printer_id")) if job.get("printer_id") else None
        if not target or not target.get("printer_ip"):
            raise RuntimeError("no printer assigned to this job (or its IP is unset)")

        if job.get("type") == "test":
            image = render_test_badge(template, label)
        else:
            # External API jobs carry the name directly; our own form jobs
            # reference a form_entries row via entry_id.
            first = job.get("first_name")
            last = job.get("last_name")
            pronouns = job.get("pronouns")
            if not first:
                entry = db.get_entry(job["entry_id"]) if job.get("entry_id") else None
                if not entry:
                    raise RuntimeError("no name or form entry for this job")
                first = entry.get("first_name", "")
                last = entry.get("last_name")
                if not pronouns:
                    pronouns = entry.get("pronouns")
            # Custom header: per-job (API) overrides the printer's default, which
            # overrides the bundled logo in the template.
            header_url = job.get("header_image_url") or target.get("header_image_url")
            header_path = resolve_header(header_url)
            job_template = {**template, "header_image": header_path} if header_path else template
            image = render_badge(
                first or "", last or "", job_template, label, pronouns=pronouns or ""
            )

        printer.print_image(
            image,
            target["printer_ip"],
            target.get("port", 9100),
            cfg.get("label_media", "62"),
            rotation=int(template.get("print_rotation", 90)),
        )
        db.finish_job(job_id)
        _log(f"printed job {job_id} on '{target.get('name')}' (type={job.get('type')})")
    except Exception as e:  # noqa: BLE001 - report every failure back to the DB
        db.fail_job(job_id, e)
        _log(f"FAILED job {job_id}: {e}", err=True)


def write_heartbeat():
    now = _now()
    db.update_bridge({"bridge_last_seen": now})
    for p in db.list_printers():
        ip = p.get("printer_ip")
        status = printer.query_status(ip, p.get("port", 9100)) if ip else {"reachable": False}
        db.update_printer(
            p["id"],
            {
                "reachable": bool(status.get("reachable")),
                "media_type": status.get("media_type"),
                "media_width": status.get("media_width"),
                "error_state": status.get("error_state"),
                "last_checked": now,
            },
        )


def main():
    config.require()
    _log(f"bridge starting; polling every {config.POLL_INTERVAL}s")
    last_heartbeat = 0.0

    while True:
        try:
            cfg = db.get_config()

            job = db.get_queued_job()
            if job:
                claimed = db.claim_job(job["id"], job.get("attempts", 0))
                if claimed:
                    handle_job(claimed, cfg)
                    continue  # loop again immediately to drain the queue

            now = time.monotonic()
            if now - last_heartbeat >= config.HEARTBEAT_INTERVAL:
                write_heartbeat()
                last_heartbeat = now
        except Exception as e:  # noqa: BLE001 - keep the loop alive through transient errors
            _log(f"loop error: {e}", err=True)
            traceback.print_exc()

        time.sleep(config.POLL_INTERVAL)


if __name__ == "__main__":
    main()
