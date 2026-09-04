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

import badge
import client as client_module
import config
import discover
import provision_task
import printer
from badge import render_badge, render_test_badge

#: Under the state directory, not beside the code: the service account writes
#: here, and it has no business being able to write to the program it runs.
_HEADER_CACHE = os.path.join(config.STATE_DIR, ".header_cache")


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




def badge_template_for(target: dict, cfg: dict, header_path: str | None = None) -> dict:
    """The template to render this printer's badges with.

    The wording is a property of the printer — a lobby desk and a social hall
    can reasonably say different things — so the printer's own header and
    footer win over whatever the organization-wide template carries.

    The header is one of three things, and `badge_header_mode` says which, so
    that what the admin shows and what prints cannot drift apart:

        text   the header line, drawn as words
        logo   the organization's own name mark, uploaded in Settings
        image  a graphic uploaded for this printer

    `header_path` is an already-downloaded image to use, which overrides the
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
    else:
        # "text"; "logo" with no mark uploaded; or "image" whose upload could
        # not be fetched — degrade to the header line rather than to somebody
        # else's graphic. There is deliberately no bundled fallback: the logo
        # that used to live here was one congregation's, and any other
        # organization choosing "logo" would have printed their mark.
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
        # printer set to "image" uses the one uploaded for it; one set to
        # "logo" uses the organization's name mark, which arrives in the config
        # because it belongs to the org rather than to this printer.
        header_url = job.get("header_image_url")
        mode = target.get("badge_header_mode")
        if not header_url and mode == "image":
            header_url = target.get("header_image_url")
        elif not header_url and mode == "logo":
            header_url = cfg.get("logo_url")
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
            # Absent on an API job, which has no sign-in behind it and so no
            # way to be a visitor. Absent is a member: the ordinary badge is
            # the safe thing to print when we do not know.
            visitor = job.get("visitor_type") == "visitor"
            if not first:
                raise RuntimeError("no name or form entry for this job")
            image = render_badge(
                first or "",
                last or "",
                template,
                label,
                pronouns=pronouns or "",
                visitor=visitor,
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


def _classify_mac(ip: str, mac: str) -> str | None:
    """Which interface a MAC belongs to: "mac" (wireless), "wired_mac", or None.

    ARP hands back the MAC of whatever interface answers on this subnet and
    says nothing about which one it is. Brother builds its mDNS name from the
    MAC — BRW for wireless, BRN for wired — so resolving both names and seeing
    which one points back at this address settles it, with no credentials and
    no writes to the printer.

    None when neither answers, which happens where mDNS is blocked. Guessing
    would be worse than not knowing: a wired MAC filed under the wireless
    column is exactly the value the WiFi recovery would later search for and
    never find.
    """
    for wireless, column in ((True, "mac"), (False, "wired_mac")):
        try:
            if ip in discover.resolve_all(discover.node_name_for(mac, wireless)):
                return column
        except Exception:  # noqa: BLE001 — a naming convenience, never fatal
            continue
    return None


def _relocate(p: dict) -> str | None:
    """Where a configured printer has moved to, found by mDNS alone.

    Deliberately NOT discover.find_printer(), which falls through to sweeping
    a /24 whenever mDNS does not answer. This runs on every heartbeat for
    every unreachable printer, so a sweep here would turn one printer switched
    off overnight into a continuous scan of the customer's network. The sweep
    belongs behind an explicit "find it again" action, where somebody is
    waiting for the answer and one scan is the point.
    """
    port = p.get("port", 9100)
    for column, mac in (("mac", p.get("mac")), ("wired_mac", p.get("wired_mac"))):
        if not mac:
            continue
        try:
            addresses = discover.resolve_all(
                discover.node_name_for(mac, wireless=column == "mac")
            )
        except Exception:  # noqa: BLE001
            continue
        for ip in addresses:
            if ip != p.get("printer_ip") and printer.query_status(ip, port).get("reachable"):
                return ip
    return None


def probe_printers(printers: list) -> list:
    """Ask each printer how it is, for the next poll to report upstream.

    Also does two things that need no extra round trip when all is well:
    learns the MAC of a printer that has none recorded, and — when one cannot
    be reached at its stored address — asks mDNS whether it has simply moved.
    A DHCP lease expiring is otherwise indistinguishable from a printer that
    has failed, and it is by far the more likely of the two.
    """
    reports = []
    for p in printers:
        ip = p.get("printer_ip")
        port = p.get("port", 9100)
        status = printer.query_status(ip, port) if ip else {"reachable": False}

        if not status.get("reachable") and (p.get("mac") or p.get("wired_mac")):
            moved = _relocate(p)
            if moved:
                _log(f"{p.get('name') or p['id']} answered at {moved}, not {ip}")
                status = printer.query_status(moved, port)
                if status.get("reachable"):
                    ip = moved

        report = {
            "id": p["id"],
            "reachable": bool(status.get("reachable")),
            "media_type": status.get("media_type"),
            "media_width": status.get("media_width"),
            "error_state": status.get("error_state"),
        }
        if ip and ip != p.get("printer_ip"):
            report["printer_ip"] = ip

        # Backfill. Printers configured before MACs were recorded have none,
        # and the address is the least durable thing about a printer — so the
        # first time one is reachable, learn the identifier that outlives it.
        if status.get("reachable") and ip and not (p.get("mac") or p.get("wired_mac")):
            learned = discover.mac_of(ip)
            column = _classify_mac(ip, learned) if learned else None
            if column:
                report[column] = learned
                _log(f"learned {p.get('name') or p['id']}'s {column} ({learned})")

        reports.append(report)
    return reports


#: Present while a provisioning step is running or its result is still
#: undelivered. update.sh checks for it: restarting the bridge mid-step
#: destroys the result and strands the operator on a spinner until the
#: server's ten-minute lease expires.
_PROVISIONING_MARK = os.path.join(config.STATE_DIR, "provisioning_active")


def _mark_provisioning(active: bool) -> None:
    """Best effort; never let bookkeeping break a setup."""
    try:
        if active:
            with open(_PROVISIONING_MARK, "w", encoding="utf-8") as fh:
                fh.write(str(os.getpid()))
        else:
            os.unlink(_PROVISIONING_MARK)
    except OSError:
        pass


def handle_provision(request: dict) -> dict:
    """Run one step of a guided printer setup and package up what happened.

    The result goes back on the next poll rather than through a call of its
    own: the bridge already has exactly one channel to the server, and a step
    that finished is not more urgent than the next tick.
    """
    task = request.get("task")
    session_id = request.get("session_id")
    _log(f"provisioning step '{task}' for session {session_id}")

    _mark_provisioning(True)
    try:
        outcome = provision_task.run(task, request, log=lambda m: _log(f"  {m}"))
    except BaseException:
        _mark_provisioning(False)
        raise

    if outcome.ok:
        _log(f"provisioning step '{task}' done -> {outcome.next_state}")
    else:
        _log(f"provisioning step '{task}' failed: {outcome.error}", err=True)

    return {
        "session_id": session_id,
        "task": task,
        "ok": outcome.ok,
        "next_state": outcome.next_state,
        "data": outcome.data,
        "log": outcome.log,
        "error": outcome.error,
    }


def main():
    config.require()
    client = client_module.make_client()
    _log(f"bridge starting; auth: {client.mode}; polling every {config.POLL_INTERVAL}s")
    # Say which font we found at startup. A machine with none prints a badge
    # nobody can read, and until this line existed you only found out from the
    # badge itself.
    try:
        _log(f"font: {badge._load_font(60, bold=True).path}")
    except Exception as e:
        _log(f"WARNING: {e}", err=True)
    if client.mode.startswith("service_role"):
        _log(
            "WARNING: running on the project-wide service_role key, which can reach "
            "every organization. Issue a bridge token in the admin (Print servers) "
            "and set BRIDGE_TOKEN in bridge/.env.",
            err=True,
        )

    last_probe = 0.0
    printers = []
    provision_result = None
    suspended_logged = False

    while True:
        try:
            # Probing each printer costs a TCP round trip, so it keeps the slower
            # heartbeat cadence; job polling stays fast.
            now = time.monotonic()
            reports = None
            if now - last_probe >= config.HEARTBEAT_INTERVAL:
                reports = probe_printers(printers)
                last_probe = now

            result = client.poll(reports, provision_result)
            if provision_result is not None:
                # Delivered. Only now may an update restart us safely.
                _mark_provisioning(False)
            provision_result = None
            cfg, printers = result.config, result.printers

            if result.suspended:
                # Said once per spell rather than every couple of seconds: this
                # can last days, and a log full of it hides everything else.
                if not suspended_logged:
                    _log("this organization is suspended; no jobs will be issued")
                    suspended_logged = True
                time.sleep(config.POLL_INTERVAL)
                continue
            suspended_logged = False

            if result.rotated:
                _log("credential renewed and stored")

            if result.provision:
                # One step of a guided printer setup, claimed for us by the
                # server. These block the loop for as long as a few minutes —
                # acceptable, because a printer being set up is not yet printing
                # anything, and nobody is provisioning during a service.
                provision_result = handle_provision(result.provision)
                # Report it NOW rather than on the next tick.
                #
                # A finished step's result lives only in this variable until
                # the next poll. A restart in that window throws away work
                # that actually completed, and the server — which has the step
                # leased to us for ten minutes — shows a spinner for all ten
                # before anyone may retry it. That happened: an update
                # restarted the bridge one second after a configure finished,
                # and the whole step was lost with it.
                continue

            if result.job:
                handle_job(client, result.job, cfg, printers)
                continue  # loop again immediately to drain the queue
        except Exception as e:  # noqa: BLE001 - keep the loop alive through transient errors
            _log(f"loop error: {e}", err=True)
            traceback.print_exc()

        time.sleep(config.POLL_INTERVAL)


if __name__ == "__main__":
    main()
