"""Offline tests for configure_printer().

Runs against a stub HTTP server reproducing the QL-820NWB's actual page shapes
(captured in docs/PRINTER_RECON_QL820NWB.md) — no printer, no network. What
matters here is the behaviour that is awkward to check against real hardware:
that whole forms are posted back rather than single fields, that the CSRF token
is carried, that WiFi really is applied last, that a connection dropping during
the WiFi step reads as success, and that no secret reaches the transcript.

    ./venv/bin/python test_printer_config.py
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

FAILURES = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        FAILURES.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


PASSWORD = "aguQreSK"
TOKEN = "tok-abc123"

# Page shapes lifted from the real device: a pageid, a CSRF token, a
# postif_registration_reject, and selects whose current value is the option
# carrying `selected`.
PAGES = {
    "/general/status.html": f"""
      <form method="post" action="/general/status.html">
        <input type="hidden" name="CSRFToken" value="{TOKEN}"/>
        <input type="password" name="B128"/>
        <input type="hidden" name="loginurl" value="/general/status.html"/>
      </form>""",
    "/general/information.html": """
      <dt>Model Name</dt><dd>QL-820NWB</dd>
      <dt>Serial no.</dt><dd>B6G868653</dd>
      <dt>Firmware Version</dt><dd>1.32</dd>""",
    "/general/date.html": f"""
      <form method="post" action="/general/date.html">
        <input type="hidden" name="pageid" value="10"/>
        <input type="hidden" name="CSRFToken" value="{TOKEN}"/>
        <input type="hidden" name="postif_registration_reject" value="1"/>
        <input type="text" name="B3f" value="01"/><input type="text" name="B40" value="01"/>
        <input type="text" name="B3e" value="2016"/>
        <input type="text" name="B41" value="00"/><input type="text" name="B42" value="00"/>
        <input type="hidden" name="B3d" value="0"/>
      </form>""",
    "/printer/device_settings.html": f"""
      <form method="post" action="/printer/device_settings.html">
        <input type="hidden" name="pageid" value="159"/>
        <input type="hidden" name="CSRFToken" value="{TOKEN}"/>
        <select name="B24"><option value="20">ESC/P</option>
          <option value="21">Raster</option>
          <option value="22" selected="selected">P-touch Template</option></select>
        <select name="B28"><option value="2">German</option>
          <option value="3" selected="selected">English</option></select>
        <select name="B30"><option value="0" selected="selected">Auto Cut</option>
          <option value="1">OFF</option></select>
      </form>""",
    "/printer/power_settings.html": f"""
      <form method="post" action="/printer/power_settings.html">
        <input type="hidden" name="pageid" value="158"/>
        <input type="hidden" name="CSRFToken" value="{TOKEN}"/>
        <select name="B1c"><option value="0" selected="selected">Disable</option>
          <option value="1">Enable</option></select>
        <select name="B1d"><option value="0">None</option>
          <option value="6" selected="selected">60 Mins</option></select>
        <select name="B1e"><option value="6" selected="selected">60 Mins</option></select>
      </form>""",
    "/printer/communication_settings.html": f"""
      <form method="post" action="/printer/communication_settings.html">
        <input type="hidden" name="pageid" value="161"/>
        <input type="hidden" name="CSRFToken" value="{TOKEN}"/>
        <select name="B32"><option value="0" selected="selected">Infrastructure or Adhoc</option>
          <option value="2">Wireless Direct</option></select>
      </form>""",
    "/net/wireless/wireless.html": f"""
      <form method="post" action="wireless.html">
        <input type="hidden" name="pageid" value="217"/>
        <input type="hidden" name="CSRFToken" value="{TOKEN}"/>
        <select name="B62"><option value="1" selected="selected">Infrastructure</option>
          <option value="2">Ad-hoc</option></select>
        <input type="text" name="Bde" value="QL-820NWB_68653"/>
        <select name="B63"><option value="1" selected="selected">Open System</option>
          <option value="3">WPA/WPA2-PSK</option></select>
        <input type="radio" name="Be6" value="1" checked="checked"/>
        <input type="radio" name="Be6" value="2"/>
        <input type="password" name="Bf8" value=""/>
        <input type="hidden" name="wlan" value="2"/>
      </form>""",
    "/net/net/net.html": """
      <dt>Wireless</dt><dd>IEEE 802.11b/g/n</dd><dd>(Inactive)</dd>""",
}


class Stub(BaseHTTPRequestHandler):
    posts = []          # (path, fields)
    logged_in = False
    wifi_drops = False  # simulate the link dying as WiFi applies

    def log_message(self, *a):
        pass

    def _send(self, body, status=200):
        b = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        path = urlparse(self.path).path
        page = PAGES.get(path)
        if page is None:
            self._send("not found", 404)
            return
        header = "Logout" if Stub.logged_in else ""
        self._send(f"<html><body>{header}{page}</body></html>")

    def do_POST(self):
        path = urlparse(self.path).path
        n = int(self.headers.get("Content-Length") or 0)
        fields = {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode()).items()}
        Stub.posts.append((path, fields))

        if path == "/general/status.html":       # the login form
            if fields.get("B128") == PASSWORD:
                Stub.logged_in = True
                self._send("<html><body>Logout</body></html>")
            else:
                self._send(f'<html><body><input type="password" name="B128"/></body></html>')
            return

        if path == "/net/wireless/wireless.html" and Stub.wifi_drops:
            # What a printer switching interfaces looks like from the client end.
            self.close_connection = True
            raise ConnectionResetError("link dropped")

        self._send('<html><body><div class="postSuccess">Submit OK</div></body></html>')


server = HTTPServer(("127.0.0.1", 0), Stub)
threading.Thread(target=server.serve_forever, daemon=True).start()
IP = f"127.0.0.1:{server.server_address[1]}"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import printer_config as pc  # noqa: E402

print("— a full configuration run —")
Stub.posts, Stub.logged_in = [], False
res = pc.configure_printer(
    IP, PASSWORD,
    ssid="Lobby-WiFi", passphrase="hunter2-not-real",
    now=time.struct_time((2026, 8, 23, 14, 5, 0, 0, 0, 0)),
)
paths = [p for p, _ in Stub.posts]
sent = {p: f for p, f in Stub.posts}

check("identifies the printer", res.model == "QL-820NWB" and res.firmware == "1.32", res.firmware)
check("every step succeeded", res.ok, res.transcript())
check("logs in before configuring", paths[0] == "/general/status.html")
check("WiFi is applied last", paths[-1] == "/net/wireless/wireless.html", str(paths))

print("— whole forms are posted back, not just the change —")
power = sent["/printer/power_settings.html"]
check("carries the untouched fields", power.get("B1e") == "6", json.dumps(power))
check("carries pageid", power.get("pageid") == "158")
check("carries the CSRF token", power.get("CSRFToken") == TOKEN)
check("applies auto power on", power.get("B1c") == "1")
check("disables the 60-minute sleep", power.get("B1d") == "0")

print("— the settings we actually care about —")
date = sent["/general/date.html"]
check("sets the clock from the supplied time",
      (date.get("B3e"), date.get("B3f"), date.get("B40"), date.get("B41"), date.get("B42"))
      == ("2026", "08", "23", "14", "05"), json.dumps(date))
dev = sent["/printer/device_settings.html"]
check("sets the panel language", dev.get("B28") == "3")
check("leaves Command Mode alone", dev.get("B24") == "22", "should not touch B24")
wifi = sent["/net/wireless/wireless.html"]
check("joins the named network", wifi.get("Bde") == "Lobby-WiFi")
check("selects WPA/WPA2-PSK", wifi.get("B63") == "3")
check("sends the passphrase", wifi.get("Bf8") == "hunter2-not-real")
check("keeps infrastructure mode", wifi.get("B62") == "1")

print("— nothing secret reaches the transcript —")
t = res.transcript()
check("passphrase is redacted", "hunter2-not-real" not in t, t)
check("password is redacted", PASSWORD not in t)
check("CSRF token is omitted", TOKEN not in t)
check("transcript still names each step", "join the wireless network" in t and "set the clock" in t)

print("— a dropped link during the WiFi step is success, not failure —")
Stub.posts, Stub.logged_in, Stub.wifi_drops = [], False, True
res2 = pc.configure_printer(IP, PASSWORD, ssid="Lobby-WiFi", passphrase="pw", set_clock=False)
wifi_step = [s for s in res2.steps if "wireless network" in s.name][-1]
check("reports the dropped connection as expected", wifi_step.ok, wifi_step.detail)
check("says why in the transcript", "expected" in wifi_step.detail.lower(), wifi_step.detail)
check("records that WiFi was applied", res2.wifi_applied)
Stub.wifi_drops = False

print("— a wrong password is refused clearly —")
Stub.logged_in = False
try:
    pc.configure_printer(IP, "wrong-password", set_clock=False)
    check("raises on a bad password", False, "no exception")
except RuntimeError as e:
    check("raises on a bad password with actionable wording", "password" in str(e).lower(), str(e))

print("— skipping WiFi leaves the printer wired —")
Stub.posts, Stub.logged_in = [], False
res3 = pc.configure_printer(IP, PASSWORD, set_clock=False)
check("no wireless page is touched",
      "/net/wireless/wireless.html" not in [p for p, _ in Stub.posts])
check("wifi_applied stays false", res3.wifi_applied is False)

print("— the safe-to-unplug signal —")
check("reads the wireless interface state", pc.wireless_active(IP) is False)
check("returns None when unreachable", pc.wireless_active("127.0.0.1:1") is None)

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
