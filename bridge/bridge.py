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

import client as client_module
import config
import discover
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


#: Shipped in bridge/assets/. Currently one congregation's mark — it should
#: become a per-organization upload, at which point this constant goes away.
BUNDLED_LOGO = "shir-hadash-logo.png"


def badge_template_for(target: dict, cfg: dict, header_path: str | None = None) -> dict:
    """The template to render this printer's badges with.

    The wording is a property of the printer — a lobby desk and a social hall
    can reasonably say different things — so the printer's own header and
    footer win over whatever the organization-wide template carries.

    The header is one of three things, and `badge_header_mode` says which, so
    that what the admin shows and what prints cannot drift apart:

        text   the header line, drawn as words
        logo   the logo bundled with the bridge
        image  a graphic uploaded for this printer

    `header_path` is a already-downloaded image to use, which overrides the
    mode: the external print API can attach a graphic to a single job.
    """
    template = dict(cfg.get("badge_template") or {})
    if target.get("badge_header") is not None:
        template["header"] = target["badge_header"]
    if target.get("badge_subtitle") is not None:
        template["subtitle"] = target["badge_subtitle"]

    # Always decided here, never inherited from the org template: badge.py draws
    # an image whenever header_image is set, so a leftover org value would
    # silently override the printer's choice — and in a multi-tenant database
    # that could mean printing another congregation's logo.
    if header_path:
        template["header_image"] = header_path
    elif target.get("badge_header_mode") == "logo":
        template["header_image"] = BUNDLED_LOGO
    else:
        # "text", or "image" whose upload could not be fetched — degrade to the
        # header line rather than to somebody else's graphic.
        template["header_image"] = ""
    return template


def handle_job(client, job: dict, cfg: dict, printers: list):
    job_id = job["id"]
    try:
        label = cfg.get("label_media", "62")

        target = next((p for p in printers if p["id"] == job.get("printer_id")), None)
        if not target or not target.get("printer_ip"):
            raise RuntimeError("no printer assigned to this job (or its IP is unset)")

        # A per-job graphic (external API) beats the printer's own setting; a
        # printer set to "image" uses the one uploaded for it.
        header_url = job.get("header_image_url")
        if not header_url and target.get("badge_header_mode") == "image":
            header_url = target.get("header_image_url")
        header_path = resolve_header(header_url)

        template = badge_template_for(target, cfg, header_path)

        if job.get("type") == "test":
            image = render_test_badge(template, label)
        else:
            # The name arrives resolved: external API jobs carry it directly,
            # and for form jobs the server has already looked up the entry.
            first = job.get("first_name")
            last = job.get("last_name")
            pronouns = job.get("pronouns")
            if not first:
                raise RuntimeError("no name or form entry for this job")
            image = render_badge(
                first or "", last or "", template, label, pronouns=pronouns or ""
            )

        printer.print_image(
            image,
            target["printer_ip"],
            target.get("port", 9100),
            cfg.get("label_media", "62"),
            rotation=int(template.get("print_rotation", 90)),
        )
        client.complete(job_id, True)
        _log(f"printed job {job_id} on '{target.get('name')}' (type={job.get('type')})")
    except Exception as e:  # noqa: BLE001 - report every failure back to the server
        client.complete(job_id, False, e)
        _log(f"FAILED job {job_id}: {e}", err=True)


def probe_printers(printers: list) -> list:
    """Ask each printer how it is, for the next poll to report upstream."""
    reports = []
    for p in printers:
        ip = p.get("printer_ip")
        status = printer.query_status(ip, p.get("port", 9100)) if ip else {"reachable": False}
        reports.append(
            {
                "id": p["id"],
                "reachable": bool(status.get("reachable")),
                "media_type": status.get("media_type"),
                "media_width": status.get("media_width"),
                "error_state": status.get("error_state"),
            }
        )
    return reports


def main():
    config.require()
    client = client_module.make_client()
    _log(f"bridge starting; auth: {client.mode}; polling every {config.POLL_INTERVAL}s")
    if client.mode.startswith("service_role"):
        _log(
            "WARNING: running on the project-wide service_role key, which can reach "
            "every organization. Issue a bridge token in the admin (Print servers) "
            "and set BRIDGE_TOKEN in bridge/.env.",
            err=True,
        )

    last_probe = 0.0
    printers = []
    discovered = None

    while True:
        try:
            # Probing each printer costs a TCP round trip, so it keeps the slower
            # heartbeat cadence; job polling stays fast.
            now = time.monotonic()
            reports = None
            if now - last_probe >= config.HEARTBEAT_INTERVAL:
                reports = probe_printers(printers)
                last_probe = now

            result = client.poll(reports, discovered)
            discovered = None
            cfg, printers = result.config, result.printers

            if result.scan:
                # Only ever asked for just after an admin presses "scan", so the
                # cost of a sweep is paid deliberately rather than every tick.
                _log("scan requested; looking for printers on the local network")
                found = discover.discover_printers()
                discovered = [
                    {"ip": f.ip, "mac": f.mac, "model": f.model, "node_name": f.node_name}
                    for f in found
                ]
                _log(f"found {len(discovered)} printer(s); reporting on the next poll")

            if result.job:
                handle_job(client, result.job, cfg, printers)
                continue  # loop again immediately to drain the queue
        except Exception as e:  # noqa: BLE001 - keep the loop alive through transient errors
            _log(f"loop error: {e}", err=True)
            traceback.print_exc()

        time.sleep(config.POLL_INTERVAL)


if __name__ == "__main__":
    main()
