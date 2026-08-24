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
import re
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


PASSWORD = "test-printer-code"
TOKEN = "tok-abc123\nwrapped-second-line\nwrapped-third-line"

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
    # Labels carry numeric entities exactly as the device writes them.
    "/general/information.html": """
      <dt>Model&#32;Name</dt><dd>QL-820NWB</dd>
      <dt>Serial&#32;no.</dt><dd>B6G868653</dd>
      <dt>Firmware&#32;Version</dt><dd>1.32</dd>""",
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
    wifi_drops = False   # simulate the link dying as WiFi applies
    power_error = False   # simulate the printer rejecting a value
    silent_power = False  # stores the change but emits no success marker
    ignore_power = False  # claims nothing and stores nothing
    stored = {}           # what a silent page has accepted

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
        # Every real page carries a logout form in its header once signed in.
        # Its hidden B129 must never end up in a settings POST.
        if path == "/printer/power_settings.html" and Stub.stored:
            for k, v in Stub.stored.items():
                page = re.sub(rf'(<select name="{k}">)(.*?)(</select>)',
                              lambda m: m.group(1)
                              + re.sub(r'\s*selected="selected"', '', m.group(2)).replace(
                                  f'value="{v}"', f'value="{v}" selected="selected"', 1)
                              + m.group(3), page, flags=re.S)

        header = (
            f'<form method="post" action="/general/status.html">'
            f'<input type="hidden" name="CSRFToken" value="stale-header-token"/>'
            f'Logout<input type="hidden" name="B129"/></form>'
        ) if Stub.logged_in else ""
        self._send(f"<html><body>{header}{page}</body></html>")

    def do_POST(self):
        path = urlparse(self.path).path
        n = int(self.headers.get("Content-Length") or 0)
        fields = {
            k: v[0]
            # keep_blank_values matters: the logout field B129 is submitted with
            # an empty value, and dropping it would make this stub blind to the
            # exact bug it exists to catch.
            for k, v in parse_qs(self.rfile.read(n).decode(), keep_blank_values=True).items()
        }
        Stub.posts.append((path, fields))

        # The device wraps its CSRF token across lines; a browser normalises
        # those to CRLF when submitting. Insist on that, so sending the raw LF
        # the parser saw is caught here rather than on real hardware.
        if path != "/general/status.html":
            got = fields.get("CSRFToken", "")
            if got and "\n" in got and "\r\n" not in got:
                self._send("<html><body>Invalid CSRF token</body></html>")
                return

        if path == "/general/status.html":       # the login form
            if fields.get("B128") == PASSWORD:
                Stub.logged_in = True
                self._send("<html><body>Logout</body></html>")
            else:
                self._send(f'<html><body><input type="password" name="B128"/></body></html>')
            return

        # The device treats a POST carrying the logout form's field as a
        # logout, and the settings change is silently lost.
        if "B129" in fields and path != "/general/status.html":
            Stub.logged_in = False
            self._send("<html><body>logged out</body></html>")
            return

        if path == "/printer/power_settings.html" and Stub.silent_power:
            if not Stub.ignore_power:
                Stub.stored.update({k: v for k, v in fields.items() if k.startswith("B1")})
            self._send("<html><body>Wireless settings</body></html>")
            return

        if path == "/printer/power_settings.html" and Stub.power_error:
            self._send("<html><body><div>Setting&#32;value&#32;is&#32;out&#32;of&#32;range</div></body></html>")
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

check("identifies the printer through entity-escaped labels",
      res.model == "QL-820NWB" and res.serial == "B6G868653" and res.firmware == "1.32",
      f"{res.model!r} {res.serial!r} {res.firmware!r}")
check("every step succeeded", res.ok, res.transcript())
check("logs in before configuring", paths[0] == "/general/status.html")
check("WiFi is applied last", paths[-1] == "/net/wireless/wireless.html", str(paths))

print("— only the target form is submitted —")
for path, fields in Stub.posts:
    if path == "/general/status.html":
        continue
    check(f"no logout field in the POST to {path}", "B129" not in fields, str(fields))
check("no stale header token is used",
      all(f.get("CSRFToken") != "stale-header-token" for _, f in Stub.posts), "header token leaked")

print("— whole forms are posted back, not just the change —")
power = sent["/printer/power_settings.html"]
check("carries the untouched fields", power.get("B1e") == "6", json.dumps(power))
check("carries pageid", power.get("pageid") == "158")
check("carries the CSRF token, CRLF-normalised as a browser would",
      power.get("CSRFToken") == TOKEN.replace("\n", "\r\n"),
      repr(power.get("CSRFToken")))
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
check("selects AES, which only the page's script offers", wifi.get("B64") == "4",
      f"B64={wifi.get('B64')!r} — 1=None would be rejected for WPA")
check("sends the passphrase", wifi.get("Bf8") == "hunter2-not-real")
check("keeps infrastructure mode", wifi.get("B62") == "1")
for k in ("Be6", "Be8", "Bec", "Bf0", "Bf4"):
    check(f"omits the WEP field {k}, as a browser would", k not in wifi, str(sorted(wifi)))

print("— an open network sends no passphrase and no keys —")
import printer_config as _pc
open_changes, open_drop = _pc.wifi_changes("Guest", None)
check("selects Open System", open_changes.get("B63") == "1")
check("selects no encryption", open_changes.get("B64") == "1")
check("drops the passphrase too", "Bf8" in open_drop, str(open_drop))

print("— a page that stores without a success marker still counts as applied —")
Stub.logged_in, Stub.silent_power, Stub.stored = False, True, {}
res_s = pc.configure_printer(IP, PASSWORD, set_clock=False)
step_s = [x for x in res_s.steps if "power" in x.name][0]
check("verifies by reading the page back", step_s.ok, step_s.detail)
Stub.silent_power, Stub.stored = False, {}

print("— but a page that silently discards the change does not —")
Stub.logged_in, Stub.silent_power, Stub.ignore_power, Stub.stored = False, True, True, {}
res_i = pc.configure_printer(IP, PASSWORD, set_clock=False)
step_i = [x for x in res_i.steps if "power" in x.name][0]
check("reports failure when the value did not stick", not step_i.ok, step_i.detail)
Stub.silent_power = Stub.ignore_power = False
Stub.stored = {}

print("— a failed step reports what the printer said —")
Stub.logged_in, Stub.power_error = False, True
res_f = pc.configure_printer(IP, PASSWORD, set_clock=False)
Stub.power_error = False
step = [s for s in res_f.steps if "power" in s.name][0]
check("quotes the printer's own message", "out of range" in step.detail, step.detail)
check("does not just say 'did not confirm'", "did not confirm" not in step.detail, step.detail)

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

print("— the wireless scan table —")
# NOTE: the QL-820NWB's real scan markup has never been captured. These are
# constructed from the shapes such a table plausibly takes, so this proves the
# parser is sane, NOT that it matches the printer. Capture a real page with
#   curl -s 'http://<ip>/net/wireless/wireless.html?wlan=3'
# and add it here before trusting the picker.
SCAN = (
    "<table>"
    "<tr><th>SSID</th><th>Channel</th><th>Mode</th><th>Signal</th></tr>"
    "<tr><td>Guest-2G</td><td>6</td><td>802.11b/g/n</td><td>-52</td></tr>"
    "<tr><td>Lobby&#32;WiFi</td><td>11</td><td>802.11n</td><td>-61</td></tr>"
    "<tr><td>Guest-2G</td><td>6</td><td>802.11b/g/n</td><td>-52</td></tr>"
    "</table>"
)
found = pc.parse_scan(SCAN)
check("reads the names", found == ["Guest-2G", "Lobby WiFi"], str(found))
check("skips the header row", "SSID" not in found)
check("decodes entities in a name", "Lobby WiFi" in found)
check("lists each network once", len(found) == 2, str(found))

check("no table at all yields nothing", pc.parse_scan("<html><body>none</body></html>") == [])
check("malformed markup does not raise", pc.parse_scan("<table><tr><td>x") == [])

# A row of unrelated numbers must not be mistaken for a network. Channels are
# 1..14, which is the only thing separating a scan row from any other table.
other = pc.parse_scan(
    "<table><tr><td>Total pages</td><td>4211</td><td>since reset</td></tr></table>")
check("an unrelated table is not read as networks", other == [], str(other))

nested = pc.parse_scan(
    "<table><tr><td><b>Sanctuary</b></td><td>1</td><td>IEEE 802.11g</td><td>-70</td></tr></table>")
check("markup inside a name is handled", nested == ["Sanctuary"], str(nested))

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} failure(s): {', '.join(FAILURES)}")
    sys.exit(1)
print("RESULT: all checks passed")
