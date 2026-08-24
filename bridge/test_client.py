"""Offline tests for the bridge's server conversation.

Runs both backends against a stub HTTP server on localhost — no Supabase, no
printer, no network. Covers the parts that are awkward to check on a Pi in a
wiring closet: that a claimed job is understood, that outcomes are reported in
the shape the server expects, and that a revoked token produces an error an
operator can act on.

    ./venv/bin/python test_client.py
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

FAILURES = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


# --------------------------------------------------------------- stub server
class Stub(BaseHTTPRequestHandler):
    """Answers both the Edge Function routes and the PostgREST routes."""

    routes = {}
    seen = []

    def log_message(self, *args):
        pass  # keep the test output clean

    def _read(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def _respond(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self, method):
        path = self.path.split("?")[0]
        body = self._read() if method in ("POST", "PATCH") else {}
        Stub.seen.append(
            {
                "method": method,
                "path": path,
                "query": self.path.split("?")[1] if "?" in self.path else "",
                "body": body,
                "bridge_key": self.headers.get("x-bridge-key"),
            }
        )
        status, payload = Stub.routes.get(path, (404, {"error": "no stub route"}))
        self._respond(status, payload)

    def do_POST(self):
        self._handle("POST")

    def do_PATCH(self):
        self._handle("PATCH")

    def do_GET(self):
        self._handle("GET")


def serve():
    server = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


server = serve()
base = f"http://127.0.0.1:{server.server_address[1]}"

# config reads the environment at import time, so set it up first.
os.environ["SUPABASE_URL"] = base
os.environ["BRIDGE_TOKEN"] = "nbk_test_token"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import client  # noqa: E402
import config  # noqa: E402

JOB = {
    "id": "11111111-1111-4111-8111-111111111111",
    "type": "badge",
    "printer_id": "22222222-2222-4222-8222-222222222222",
    "first_name": "Ada",
    "last_name": "Lovelace",
    "pronouns": "she/her",
}
PRINTERS = [{"id": "22222222-2222-4222-8222-222222222222", "name": "Lobby", "printer_ip": "10.0.0.5", "port": 9100}]
CONFIG = {"label_media": "62", "badge_template": {"header": "WELCOME"}}

print("— the bridge picks the scoped token when one is set —")
c = client.make_client()
check("uses the bridge API, not service_role", isinstance(c, client.BridgeApiClient), c.mode)

print("— poll —")
Stub.routes = {"/functions/v1/bridge-poll": (200, {"ok": True, "config": CONFIG, "printers": PRINTERS, "job": JOB})}
Stub.seen = []
r = c.poll([{"id": PRINTERS[0]["id"], "reachable": True}])
check("returns the org's config", r.config == CONFIG, repr(r.config))
check("returns the org's printers", r.printers == PRINTERS)
check("returns the claimed job with its name resolved", r.job and r.job["first_name"] == "Ada")
check("no scan asked for by default", r.scan is False)
check("sends the bridge key as a header", Stub.seen[0]["bridge_key"] == "nbk_test_token")
check("forwards the printer status report", Stub.seen[0]["body"]["printers"][0]["reachable"] is True)

print("— an empty queue is not an error —")
Stub.routes = {"/functions/v1/bridge-poll": (200, {"ok": True, "config": CONFIG, "printers": PRINTERS, "job": None})}
r = c.poll(None)
check("no job means no job", r.job is None)

print("— completing a job —")
Stub.routes = {"/functions/v1/bridge-complete": (200, {"ok": True})}
Stub.seen = []
c.complete(JOB["id"], True)
check("reports success as 'printed'", Stub.seen[0]["body"]["status"] == "printed")
Stub.seen = []
c.complete(JOB["id"], False, RuntimeError("printer offline"))
check("reports failure as 'failed'", Stub.seen[0]["body"]["status"] == "failed")
check("passes the error text along", "printer offline" in Stub.seen[0]["body"]["error"])

print("— scanning is asked for by the server, and reported back —")
Stub.routes = {"/functions/v1/bridge-poll": (200, {"ok": True, "config": CONFIG,
                                                   "printers": PRINTERS, "job": None,
                                                   "scan": True})}
r = c.poll(None)
check("passes the scan request through", r.scan is True)

Stub.routes = {"/functions/v1/bridge-poll": (200, {"ok": True, "config": CONFIG,
                                                   "printers": PRINTERS, "job": None})}
Stub.seen = []
c.poll(None, discovered=[{"ip": "192.168.1.69", "mac": "44:f7:9f:bc:ab:e8",
                          "model": "Brother QL-820NWB", "node_name": "BRW44F79FBCABE8"}])
body = Stub.seen[0]["body"]
sent = body["discovered"]
check("reports what it found", sent and sent[0]["ip"] == "192.168.1.69", str(sent))
check("marks that a scan ran", body.get("scanned") is True, str(body))
check("includes the MAC, which is what identifies it", sent[0]["mac"] == "44:f7:9f:bc:ab:e8")

# A scan that finds nothing must still be reported, or the admin cannot tell it
# apart from a scan still running.
Stub.seen = []
c.poll(None, discovered=[])
empty = Stub.seen[0]["body"]
check("an empty result still counts as a scan", empty.get("scanned") is True, str(empty))
Stub.seen = []
c.poll(None)
check("a poll with no scan says so", Stub.seen[0]["body"].get("scanned") is False)

print("— a provisioning step is handed over, and its result reported back —")
STEP = {"session_id": "11111111-1111-4111-8111-111111111111", "task": "configure",
        "wired_ip": "192.168.1.27", "ssid": "Lobby-WiFi",
        "web_password": "test-printer-code", "wifi_passphrase": "s3cr3t"}
Stub.routes = {"/functions/v1/bridge-poll": (200, {"ok": True, "config": CONFIG,
                                                   "printers": PRINTERS, "job": None,
                                                   "provision": STEP})}
r = c.poll(None)
check("passes the step through", r.provision == STEP, str(r.provision))
check("carries the secrets the step needs",
      r.provision["wifi_passphrase"] == "s3cr3t")

Stub.routes = {"/functions/v1/bridge-poll": (200, {"ok": True, "config": CONFIG,
                                                   "printers": PRINTERS, "job": None})}
r = c.poll(None)
check("no step means none is claimed", r.provision is None, str(r.provision))

Stub.seen = []
c.poll(None, provision_result={"session_id": "s1", "task": "configure", "ok": True,
                               "next_state": "wifi_confirm", "data": {"model": "QL-820NWB"},
                               "log": ["connected"], "error": None})
body = Stub.seen[0]["body"]
check("reports the outcome", body["provision_result"]["ok"] is True, str(body))
check("says where the session goes next",
      body["provision_result"]["next_state"] == "wifi_confirm")

# The field must be absent, not null: an ordinary poll happens every few
# seconds and must not look like a step reporting in.
Stub.seen = []
c.poll(None)
check("an ordinary poll carries no provisioning result",
      "provision_result" not in Stub.seen[0]["body"], str(Stub.seen[0]["body"]))

print("— credentials renew themselves —")
import credential  # noqa: E402
import tempfile, os  # noqa: E402

credential.TOKEN_FILE = os.path.join(tempfile.mkdtemp(), "token")

Stub.routes = {"/functions/v1/bridge-poll": (200, {"ok": True, "config": CONFIG,
                                                   "printers": PRINTERS, "job": None,
                                                   "bridge_token": "nbk_replacement"})}
Stub.seen = []
r = c.poll(None)
check("says it rotated", r.rotated is True)
check("stores the replacement", credential.stored() == "nbk_replacement")

# The next request must carry the new credential. Using it is what tells the
# server to retire the old one, so this is the step that completes the handover.
Stub.routes = {"/functions/v1/bridge-poll": (200, {"ok": True, "config": CONFIG,
                                                   "printers": PRINTERS, "job": None})}
Stub.seen = []
c.poll(None)
check("authenticates with the new credential from the next poll",
      Stub.seen[0]["bridge_key"] == "nbk_replacement", str(Stub.seen[0]["bridge_key"]))
check("an ordinary poll reports no rotation error",
      "rotation_error" not in Stub.seen[0]["body"], str(Stub.seen[0]["body"]))

print("— a replacement that cannot be stored must not break the device —")
# This is the dangerous case. The credential in hand is still valid precisely
# because the server has not retired it, so the poll has to keep working and
# the failure has to be reported rather than swallowed.
real_store = credential.store
credential.store = lambda t: (_ for _ in ()).throw(OSError("read-only file system"))
Stub.routes = {"/functions/v1/bridge-poll": (200, {"ok": True, "config": CONFIG,
                                                   "printers": PRINTERS, "job": None,
                                                   "bridge_token": "nbk_cannot_store"})}
Stub.seen = []
r = c.poll(None)
credential.store = real_store
check("the poll still succeeds", r is not None and r.config == CONFIG)
check("does not claim to have rotated", r.rotated is False)
check("keeps the credential that still works", credential.stored() == "nbk_replacement")

Stub.routes = {"/functions/v1/bridge-poll": (200, {"ok": True, "config": CONFIG,
                                                   "printers": PRINTERS, "job": None})}
Stub.seen = []
c.poll(None)
check("reports the failure so the server backs off",
      "read-only file system" in str(Stub.seen[0]["body"].get("rotation_error")),
      str(Stub.seen[0]["body"].get("rotation_error")))
check("still authenticating with the working credential",
      Stub.seen[0]["bridge_key"] == "nbk_replacement")

Stub.seen = []
c.poll(None)
check("and stops repeating it once reported",
      "rotation_error" not in Stub.seen[0]["body"], str(Stub.seen[0]["body"]))

print("— a revoked or unknown token says so plainly —")
Stub.routes = {"/functions/v1/bridge-poll": (401, {"ok": False, "error": "Unknown or revoked bridge key"})}
try:
    c.poll(None)
    check("raises on 401", False, "no exception")
except RuntimeError as e:
    check("raises on 401 with actionable wording", "revoked" in str(e) and "admin" in str(e), str(e))

print("— a server-side error is surfaced, not swallowed —")
Stub.routes = {"/functions/v1/bridge-poll": (200, {"ok": False, "error": "printer_config missing"})}
try:
    c.poll(None)
    check("raises when ok is false", False, "no exception")
except RuntimeError as e:
    check("raises when ok is false", "printer_config missing" in str(e), str(e))

print("— a rotated credential outranks everything else —")
# The device above rotated, so bridge/token holds a credential. Even with .env
# emptied it must keep using the scoped path rather than dropping back to the
# project-wide key, which reaches every organization.
config.BRIDGE_TOKEN = ""
check("a stored credential still selects the scoped client",
      isinstance(client.make_client(), client.BridgeApiClient))

print("— the deprecated service_role path still works for cutover —")
# A Pi mid-cutover has neither: no token in .env, and none stored yet.
credential.TOKEN_FILE = os.path.join(tempfile.mkdtemp(), "token")
legacy = client.make_client()
check("falls back to the legacy client", isinstance(legacy, client.LegacyClient), legacy.mode)

Stub.routes = {
    "/rest/v1/printer_config": (200, [CONFIG]),
    "/rest/v1/printers": (200, PRINTERS),
    "/rest/v1/print_jobs": (200, [dict(JOB, attempts=0)]),
    "/rest/v1/printer_status": (200, []),
    "/rest/v1/form_entries": (200, [{"first_name": "Ada", "last_name": "Lovelace", "pronouns": None}]),
}
Stub.seen = []
r = legacy.poll([{"id": PRINTERS[0]["id"], "reachable": True}])
check("legacy poll returns the same shape",
      r.config == CONFIG and r.printers == PRINTERS and r.job["id"] == JOB["id"])
check("legacy poll writes the heartbeat", any(s["path"] == "/rest/v1/printer_status" for s in Stub.seen))

print("— name resolution is identical on both backends —")
entry_job = {"id": JOB["id"], "type": "badge", "entry_id": "33333333-3333-4333-8333-333333333333", "attempts": 0}
Stub.routes["/rest/v1/print_jobs"] = (200, [entry_job])
r = legacy.poll(None)
check("legacy resolves the name from the entry", r.job.get("first_name") == "Ada", repr(r.job))
check("legacy never asks for a scan", r.scan is False)
check("legacy never claims a provisioning step", r.provision is None)

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
