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
check("legacy never claims a provisioning step", r.provision is None)

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
