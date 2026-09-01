"""Drive a Brother QL-820NWB's web UI to configure it for kiosk use.

Recon behind every field name and quirk here:
`docs/PRINTER_RECON_QL820NWB.md`, captured from a factory-reset unit on
**firmware 1.32**. Field names are firmware-specific; a different version is
reported and logged rather than silently assumed to match.

What this does *not* do, and why:

* **It does not touch Command Mode.** brother_ql puts `ESC i a 01` in every job
  preamble, which switches the printer to raster for that connection whatever
  its stored default. Verified on hardware: a badge printed while the front
  panel still showed form mode. The persistent setting affects only status
  queries, which this model does not answer anyway.
* **It cannot turn off the panel's form mode.** No page in the web UI exposes
  it. Given the above, that does not matter.

Order matters. WiFi is applied last because the printer is either wired or
wireless, never both: applying it drops the Ethernet link this session is
running over. That disconnection is the *expected* outcome and is reported as
success, not failure.
"""
from __future__ import annotations

import sys

import re
import time
from dataclasses import dataclass, field
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urljoin

import requests

# Values captured from firmware 1.32. See the recon doc.
FIRMWARE_VERIFIED = "1.32"

# Firmware whose SETTINGS pages have been driven end to end on real hardware.
# 1.23 was added after a full run on serial C0Z851372 (2026-08-31): its
# settings fields are identical to 1.32 — only the login box differs, which
# _login_form now reads off the page.
FIRMWARE_SETTINGS_OK = {"1.32", "1.23"}

# Firmware whose WIRELESS page has been driven end to end. Tracked apart
# deliberately: joining a network is the step that drops the wired link, and
# undoing a bad one means a factory reset. 1.23 is NOT here — the run that
# verified its settings pages was made without --ssid, so those field names
# have still never been exercised on it.
FIRMWARE_WIRELESS_OK = {"1.32"}

SUCCESS_MARKER = "postSuccess"

# Pages, and the fields on them we care about.
PAGE_STATUS = "/general/status.html"
PAGE_INFO = "/general/information.html?kind=item"
PAGE_POWER = "/printer/power_settings.html"
PAGE_DEVICE = "/printer/device_settings.html"
PAGE_COMMS = "/printer/communication_settings.html"
PAGE_WIRELESS = "/net/wireless/wireless.html"
PAGE_DATE = "/general/date.html"
PAGE_NETSTATUS = "/net/net/net.html"
#: What the wireless page's "Browse" button calls. Answers over Ethernet with
#: the radio still unconfigured, which is what makes it usable during setup.
PAGE_WIRELESS_SCAN = "/net/wireless/wireless.html?wlan=3"

# The login field's name is NOT stable across firmware: 1.32 calls it B128 and
# 1.23 calls it B126. Kept only as a fallback and to redact it from
# transcripts — the name actually used is read from the page. See _login_form.
F_PASSWORD = "B128"          # login (1.32; read from the page at run time)
F_PASSWORD_ALT = "B126"      # login (1.23)
F_AUTO_POWER_ON = "B1c"      # 0 disable, 1 enable
F_AUTO_POWER_OFF_AC = "B1d"  # 0 None … 6 60 Mins
F_LANGUAGE = "B28"           # 3 English
F_RADIO_ON_POWER = "B31"     # 0 on by default, 1 off by default, 2 keep current state
F_INTERFACE = "B32"          # 0 infrastructure/adhoc, 1 +wireless direct, 2 direct
F_COMM_MODE = "B62"          # 1 infrastructure, 2 ad-hoc
F_SSID = "Bde"
F_AUTH = "B63"               # 1 open, 2 shared key, 3 WPA/WPA2-PSK
F_ENCRYPTION = "B64"         # 1 none, 2 WEP, 3 TKIP, 4 AES
F_PASSPHRASE = "Bf8"
# WEP key selector and the four keys. A browser disables these unless the
# encryption mode is WEP, and disabled controls are not submitted.
WEP_FIELDS = ("Be6", "Be8", "Bec", "Bf0", "Bf4")
F_YEAR, F_MONTH, F_DAY = "B3e", "B3f", "B40"
F_HOUR, F_MINUTE = "B41", "B42"

# Anything whose value must never reach a transcript.
SECRET_FIELDS = {F_PASSWORD, F_PASSWORD_ALT, F_PASSPHRASE, "Be8", "Bec", "Bf0", "Bf4"}


class _FormParser(HTMLParser):
    """Pull one form's controls out of a page, with their current values.

    The device's forms must be posted back whole — sending only the changed
    field loses the rest — so this collects defaults for everything, including
    which `<option>` is selected and which radio is checked.

    Crucially it collects **only the form being submitted**. Every page also
    carries a logout form in its header, and including that form's hidden field
    (`B129`) in a settings POST makes the printer treat the request as a logout
    and reject the change.
    """

    def __init__(self, want_action: str) -> None:
        super().__init__(convert_charrefs=True)
        self.fields: dict[str, str] = {}
        self._want = want_action.split("?")[0]
        self._in_form = False
        self._select: str | None = None
        self._select_has_selection = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k: (v or "") for k, v in attrs}
        if tag == "form":
            action = a.get("action", "").split("?")[0]
            # Match on the last path segment: the device writes actions both
            # absolutely ("/net/wireless/wireless.html") and relatively
            # ("wireless.html") for the same form.
            self._in_form = bool(action) and (
                action == self._want or action.rsplit("/", 1)[-1] == self._want.rsplit("/", 1)[-1]
            )
            return
        if not self._in_form:
            return
        if tag == "input":
            name, itype = a.get("name"), a.get("type", "text").lower()
            if not name or itype in ("submit", "button", "reset"):
                return
            if itype in ("radio", "checkbox"):
                if "checked" in a:
                    self.fields[name] = a.get("value", "on")
            else:
                self.fields[name] = a.get("value", "")
        elif tag == "select":
            self._select = a.get("name")
            self._select_has_selection = False
            if self._select:
                self.fields.setdefault(self._select, "")
        elif tag == "option" and self._select:
            # First option is the fallback; an explicit `selected` wins.
            if "selected" in a:
                self.fields[self._select] = a.get("value", "")
                self._select_has_selection = True
            elif not self._select_has_selection and not self.fields.get(self._select):
                self.fields[self._select] = a.get("value", "")

    def handle_endtag(self, tag: str) -> None:
        if tag == "select":
            self._select = None
        elif tag == "form":
            self._in_form = False


class _LabelParser(HTMLParser):
    """Map each named control on a page to the visible text just before it."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.pairs: list[tuple[str, str]] = []
        self._text: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k: (v or "") for k, v in attrs}
        if tag in ("option", "script", "style"):
            self._skip += 1
            return
        if tag in ("input", "select", "textarea"):
            name = a.get("name")
            if name and a.get("type", "text").lower() not in ("submit", "button", "reset"):
                self.pairs.append((" ".join("".join(self._text).split()), name))
            self._text = []

    def handle_endtag(self, tag: str) -> None:
        if tag in ("option", "script", "style") and self._skip:
            self._skip -= 1
        elif tag == "select":
            self._text = []

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self._text.append(data)


#: What each control on the wireless page is called, in words. Matched against
#: the label the page prints next to it.
_WIRELESS_LABELS = (
    ("ssid", ("wireless network name", "ssid")),
    ("passphrase", ("passphrase",)),
    ("comm_mode", ("communication mode",)),
    ("auth", ("authentication method",)),
    ("encryption", ("encryption mode",)),
    ("network_key", ("network key",)),
)

#: The names on firmware 1.32, used when a label cannot be found.
WIRELESS_DEFAULTS = {
    "ssid": F_SSID,
    "passphrase": F_PASSPHRASE,
    "comm_mode": F_COMM_MODE,
    "auth": F_AUTH,
    "encryption": F_ENCRYPTION,
    "network_key": WEP_FIELDS[0],
    "wep": list(WEP_FIELDS[1:]),
}


def wireless_fields(html: str) -> dict[str, object]:
    """Resolve the wireless page's field names from the labels beside them.

    Firmware 1.23 numbers this page two lower than 1.32 from the SSID field
    onwards — SSID is Bdc not Bde, the passphrase Bf6 not Bf8, the WEP keys
    Be6/Bea/Bee/Bf2 not Be8/Bec/Bf0/Bf4 — while the three fields below it
    (B62, B63, B64) are unchanged. The login box moved by the same two, which
    is what made a renamed field look like a dropped session for an evening.

    So the names are not a fact about this product; they are a fact about a
    build of its firmware. The labels are not: "Passphrase" is "Passphrase" on
    both. Reading the name off the page is the only version of this that does
    not need revisiting when the numbering shifts again.

    Falls back to the 1.32 names for anything it cannot find, so a page shaped
    in some third way degrades to today's behaviour rather than to nothing.
    """
    parser = _LabelParser()
    parser.feed(html)

    found: dict[str, object] = {}
    wep: list[str] = []
    for label, name in parser.pairs:
        # Only the tail. The first control on the page is preceded by the whole
        # status table above the form, which prints the current SSID — so
        # matching the entire run of text ahead of a control identified the
        # Communication Mode dropdown as the SSID box. A label sits directly
        # before its control; the longest of them here is 28 characters.
        low = label.lower()[-48:]
        if re.match(r"wep\s*key\s*\d", low):
            if name not in wep:
                wep.append(name)
            continue
        for key, phrases in _WIRELESS_LABELS:
            if key in found:
                continue
            if any(phrase in low for phrase in phrases):
                found[key] = name
                break

    if wep:
        found["wep"] = wep
    for key, default in WIRELESS_DEFAULTS.items():
        found.setdefault(key, default)

    # Whatever THIS firmware calls the passphrase and the WEP keys is a secret
    # on this firmware, so register the resolved names for redaction. The
    # static list below is the 1.32 numbering; on 1.23 the passphrase is Bf6,
    # which is not in it, and a transcript would have printed a customer's
    # network key in clear in the provisioning console.
    SECRET_FIELDS.add(str(found["passphrase"]))
    SECRET_FIELDS.update(str(n) for n in found["wep"])
    return found


def wifi_changes(
    ssid: str, passphrase: str | None, fields: dict[str, object] | None = None
) -> tuple[dict[str, str], tuple[str, ...]]:
    """The fields to set, and the fields to leave out, for joining a network.

    Both halves come from the page's own script (`/common/js/wireless.js`),
    which is the only place the real rules are written down:

    * Choosing WPA/WPA2-PSK **replaces** the encryption choices with TKIP (3)
      and AES (4). Neither appears in the static page, so leaving the field at
      its "None" default sends a combination the printer will not accept. AES
      is the right one for WPA2.
    * The script disables the WEP key fields unless the encryption mode is WEP,
      and disables the passphrase unless the method is WPA/WPA2-PSK. A browser
      does not submit disabled controls, so neither do we.
    """
    f = fields or WIRELESS_DEFAULTS
    drop = tuple([str(f["network_key"])] + [str(n) for n in f["wep"]])

    changes: dict[str, str] = {str(f["comm_mode"]): "1", str(f["ssid"]): ssid}
    if passphrase:
        # Verified identical on 1.23: its wireless.js builds the same options,
        # new Option(WPA_WPA2, 3) and new Option(AES, 4). The numbering that
        # shifted is the field names, not the values they take.
        changes[str(f["auth"])] = "3"          # WPA/WPA2-PSK
        changes[str(f["encryption"])] = "4"    # AES — WPA2's cipher; 3 is legacy TKIP
        changes[str(f["passphrase"])] = passphrase
        return changes, drop
    # An open network: no passphrase, no keys.
    changes[str(f["auth"])] = "1"
    changes[str(f["encryption"])] = "1"
    return changes, drop + (str(f["passphrase"]),)


def _form_encode(fields: dict[str, str]) -> dict[str, str]:
    """Normalise values the way a browser does before urlencoding them.

    The device wraps its CSRF token across several lines inside the `value`
    attribute. A browser submitting that form normalises those newlines to
    CRLF; sending the raw LF the parser saw produces a different byte string
    and the token no longer matches.
    """
    return {k: re.sub(r"\r\n|\r|\n", "\r\n", v) if isinstance(v, str) else v
            for k, v in fields.items()}


def _explain(body: str) -> str:
    """A short, readable account of what the printer said, for a failed step."""
    text = re.sub(r"<[^>]+>", " ", unescape(body))
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return "the printer returned an empty page (the session may have expired)"
    if "Login" in text and "Logout" not in text:
        return "the printer returned the login page (the session was not accepted)"
    return f"the printer said: {text[:200]}"


def _redact(fields: dict[str, str]) -> dict[str, str]:
    return {
        k: ("(redacted)" if k in SECRET_FIELDS and v else v)
        for k, v in fields.items()
        if k != "CSRFToken"
    }


@dataclass
class Step:
    """One configuration action, as it happened."""

    name: str
    ok: bool
    detail: str = ""
    sent: dict[str, str] = field(default_factory=dict)


@dataclass
class Interface:
    node_name: str = ""
    mac: str = ""
    active: bool = False


@dataclass
class Result:
    model: str = ""
    serial: str = ""
    firmware: str = ""
    steps: list[Step] = field(default_factory=list)
    wifi_applied: bool = False
    #: Read before the WiFi step, because afterwards the printer is gone from
    #: this address and the wireless MAC is the only way to find it again.
    wired: Interface = field(default_factory=Interface)
    wireless: Interface = field(default_factory=Interface)

    @property
    def ok(self) -> bool:
        return all(s.ok for s in self.steps)

    @property
    def refused(self) -> bool:
        """Did the printer stop accepting the session part way through?

        Which in practice means the password was wrong. Worth separating from
        an ordinary failed setting, because the operator can do something about
        it and the remedy is not the same.
        """
        return any(not s.ok and "login page" in s.detail for s in self.steps)

    def transcript(self) -> str:
        """A human-readable account, safe to paste into a support ticket."""
        lines = [
            f"printer {self.model or '?'} serial {self.serial or '?'} firmware {self.firmware or '?'}"
        ]
        if self.firmware and self.firmware not in FIRMWARE_SETTINGS_OK:
            lines.append(
                f"  ! firmware {self.firmware} differs from the verified {FIRMWARE_VERIFIED};"
                " field names may not match"
            )
        if self.wireless.mac:
            lines.append(
                f"  wireless interface {self.wireless.node_name or '?'} "
                f"({self.wireless.mac}) — find it at {self.wireless.node_name or '?'}.local"
            )
        for s in self.steps:
            lines.append(f"  [{'ok ' if s.ok else 'FAIL'}] {s.name}"
                         + (f" — {s.detail}" if s.detail else ""))
            for k, v in _redact(s.sent).items():
                lines.append(f"        {k} = {v}")
        return "\n".join(lines)


class _LoginFormParser(HTMLParser):
    """Locate the login form on a page by its shape rather than its field name.

    The password input is called B128 on firmware 1.32 and B126 on 1.23.
    Hardcoding either one does not merely fail — it fails *silently and in both
    directions*. Against 1.23 the login posted the password under a name the
    printer ignored, so it was never authenticated; and the check meant to
    catch that looked for B128, did not find it, and concluded it was logged
    in. Every later write then came back as the login page and was reported as
    a dropped session. The printer's clock was the only thing that changed,
    because that page happens not to require a login.

    What is stable across both is that the form contains an input of
    type="password". That is what we match on, and we submit the form's own
    hidden fields rather than reconstructing them.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.action = ""
        self.field = ""
        self.hidden: dict[str, str] = {}
        self._action = ""
        self._field = ""
        self._hidden: dict[str, str] = {}
        self._marked = False
        self._in_form = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k: (v or "") for k, v in attrs}
        if tag == "form":
            self._in_form = True
            self._action = a.get("action", "")
            self._field = ""
            self._hidden = {}
            self._marked = False
            return
        if not self._in_form or tag != "input":
            return
        name, itype = a.get("name"), a.get("type", "text").lower()
        if not name:
            return
        if itype == "password":
            self._field = name
            # The login box carries this id on both firmwares.
            if a.get("id") == "LogBox":
                self._marked = True
        elif itype not in ("submit", "button", "reset"):
            self._hidden[name] = a.get("value", "")
            # The login form is the one that says where to go on failure. This
            # marker is what separates it from a settings form that merely
            # contains password-typed inputs — the wireless page has five of
            # them (a passphrase and four WEP keys), and matching on
            # type="password" alone declared it a login page while we were
            # demonstrably logged into it.
            if name == "loginurl":
                self._marked = True

    def handle_endtag(self, tag: str) -> None:
        if tag != "form" or not self._in_form:
            return
        self._in_form = False
        # First form carrying a *marked* password box wins.
        if self._field and self._marked and not self.field:
            self.action, self.field, self.hidden = self._action, self._field, self._hidden


def _login_form(html: str) -> _LoginFormParser | None:
    """The page's login form, or None when it does not offer one."""
    p = _LoginFormParser()
    p.feed(html)
    return p if p.field else None


def is_login_page(html: str) -> bool:
    """Whether this page is asking us to log in.

    Deliberately not `name="B128" in html`. That was the old test, and on 1.23
    it answered False for a page whose entire content was "To Access this page
    you are required to Login" — which is how an unauthenticated run got
    mistaken for a firmware incompatibility.
    """
    return _login_form(html) is not None


class PrinterWeb:
    """A logged-in session against one printer's web UI."""

    def __init__(self, ip: str, password: str, timeout: float = 15.0) -> None:
        self.base = f"http://{ip}"
        self.password = password
        self.timeout = timeout
        self.session = requests.Session()
        # Look like the browser this UI was written for. There is precedent in
        # this codebase for embedded servers refusing plain programmatic
        # requests (see shulcloud-sync, which needs the same treatment).
        self.session.headers.update({
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        })

    # ---------------------------------------------------------------- plumbing
    def get(self, path: str) -> str:
        r = self.session.get(self.base + path, timeout=self.timeout)
        r.raise_for_status()
        return r.text

    def fields_of(self, path: str) -> dict[str, str]:
        """Current values of the form on `path` that posts back to `path`."""
        p = _FormParser(path)
        p.feed(self.get(path))
        return p.fields

    def login(self) -> None:
        """Authenticate. The login form posts to the page it is displayed on,
        so it cannot be told apart from that page's own settings form by action
        alone — it is identified by carrying the password field."""
        html = self.get(PAGE_STATUS)
        form = _login_form(html)
        if form is not None:
            # The form's own hidden fields, whatever they are on this firmware
            # — CSRFToken on some, a loginurl pointing at an error page on
            # others. Reconstructing them by hand is what made this brittle.
            data = dict(form.hidden)
            data[form.field] = self.password
            self.login_field = form.field
            action = urljoin(self.base + PAGE_STATUS, form.action or PAGE_STATUS)
            r = self.session.post(action, data=data, timeout=self.timeout)
            r.raise_for_status()
        # Verify against a freshly fetched settings page rather than the login
        # response.
        #
        # The old check read the response body for a password box and treated
        # the word "Logout" anywhere as proof of success. It let a wrong
        # password through on a real printer: login appeared to work, and every
        # subsequent write came back as the login page. The operator was then
        # shown a firmware warning, because that is what the transcript led
        # with, and no mention of the password at all.
        #
        # A page that still offers somewhere to type a password is a page we
        # are not authenticated on. That holds whatever else the markup says.
        # Verified against a page that requires a login, by shape rather than by
        # field name. The old test named B128 and so could not see a 1.23 login
        # page at all: it reported success on a session that did not exist.
        if is_login_page(self.get(PAGE_COMMS)):
            raise RuntimeError("the printer rejected the web-UI password")

    def submit(
        self, path: str, changes: dict[str, str], drop: tuple[str, ...] = ()
    ) -> tuple[bool, dict[str, str], str]:
        """Post a page back with `changes` applied over its current values.

        `drop` removes fields the page's own script would have disabled, since
        a browser does not submit those and the printer may reject them.

        Success is decided by **reading the page back** and checking the values
        took, falling back to the success marker only when there is nothing
        readable to compare. The marker is not reliable everywhere — the
        wireless page stores its settings without emitting one, so trusting it
        reports failure on a write that worked.
        """
        page = self.get(path)
        parser = _FormParser(path)
        parser.feed(page)
        fields = parser.fields
        if not fields:
            # No form to post back. Sending just the changed field produces a
            # request with no page context, which the printer answers with the
            # login page — indistinguishable, to the caller, from a session
            # that expired. Four rounds of debugging went into that confusion;
            # say which it is instead.
            if is_login_page(page):
                raise RuntimeError(
                    f"not logged in: {path} came back as the login page"
                )
            raise RuntimeError(
                f"{path} served no form to post back "
                f"(firmware {FIRMWARE_VERIFIED} is what this was built against)"
            )
        fields.update(changes)
        for key in drop:
            fields.pop(key, None)
        r = self.session.post(
            self.base + path,
            data=_form_encode(fields),
            timeout=self.timeout,
            # Some embedded UIs check that the post came from their own page.
            headers={"Referer": self.base + path},
        )
        r.raise_for_status()

        if SUCCESS_MARKER in r.text:
            return True, fields, r.text

        # Read back what actually stuck. Secrets are never echoed, so they
        # cannot be verified this way and are not counted against the result.
        checkable = {k: v for k, v in changes.items() if k not in SECRET_FIELDS}
        if not checkable:
            return False, fields, r.text
        try:
            now = self.fields_of(path)
        except requests.RequestException:
            return False, fields, r.text
        applied = all(now.get(k) == v for k, v in checkable.items())
        return applied, fields, r.text


def _identity(web: PrinterWeb) -> tuple[str, str, str]:
    """Model, serial and firmware, for keying field names to a known version."""
    # The device writes its labels with numeric entities — "Model&#32;Name" —
    # so the markup has to be unescaped before any of them will match.
    html = unescape(web.get(PAGE_INFO))
    text = re.sub(r"<[^>]+>", "|", html)
    text = re.sub(r"\s+", " ", text)

    def after(label: str) -> str:
        m = re.search(re.escape(label) + r"\s*\|+\s*([^|]+)", text)
        return m.group(1).strip() if m else ""

    return after("Model Name"), after("Serial no."), after("Firmware Version")


def _interfaces(web: PrinterWeb) -> tuple[Interface, Interface]:
    """The wired and wireless interfaces, in that order.

    Both node names and both MACs are on the network status page. The wireless
    one is what matters: it is what the printer will answer to once it has
    moved, and it cannot be read afterwards from this side of the cable.
    """
    text = re.sub(r"<[^>]+>", "|", unescape(web.get(PAGE_NETSTATUS)))
    text = re.sub(r"\s+", " ", text)
    names = re.findall(r"Node Name\s*\|+\s*([A-Za-z0-9]+)", text)
    macs = re.findall(r"MAC address\s*\|+\s*([0-9a-fA-F:-]{11,})", text)
    states = re.findall(r"\((Active|Inactive)\)", text)

    def at(i: int) -> Interface:
        return Interface(
            node_name=names[i] if i < len(names) else "",
            mac=(macs[i].replace("-", ":").lower() if i < len(macs) else ""),
            active=(states[i] == "Active") if i < len(states) else False,
        )

    return at(0), at(1)


def wait_for_wireless(ip: str, timeout: float = 180.0, interval: float = 5.0, log=None) -> bool:
    """Poll until the printer reports its wireless interface up.

    This is the "safe to unplug the Ethernet cable" signal. Note it has to be
    asked of the printer over the *wired* connection, before the cable is
    pulled — which is the only window in which both are reachable.
    """
    say = log or (lambda _m: None)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = wireless_active(ip)
        if state:
            return True
        say("    wireless not up yet …")
        time.sleep(interval)
    return False


def configure_printer(
    ip: str,
    password: str,
    *,
    ssid: str | None = None,
    passphrase: str | None = None,
    auto_power_on: bool = True,
    disable_auto_power_off: bool = True,
    set_clock: bool = True,
    now: time.struct_time | None = None,
    log=None,
) -> Result:
    """Configure a QL-820NWB over Ethernet for kiosk use.

    Returns a `Result` carrying a redacted transcript of everything attempted.
    Raises only if the printer cannot be reached or the password is refused —
    an individual setting that fails is recorded and the rest still run.

    Pass `ssid`/`passphrase` to move the printer onto WiFi. That step is last,
    and the Ethernet link is expected to drop as it applies.
    """
    say = log or (lambda _m: None)
    web = PrinterWeb(ip, password)
    result = Result()

    web.login()
    result.model, result.serial, result.firmware = _identity(web)
    result.wired, result.wireless = _interfaces(web)
    say(f"connected to {result.model or 'printer'} at {ip} (firmware {result.firmware or '?'})")
    if result.wireless.mac:
        say(f"  its wireless interface is {result.wireless.node_name} ({result.wireless.mac})")
    if result.firmware and result.firmware not in FIRMWARE_SETTINGS_OK:
        say(
            f"WARNING: firmware {result.firmware} has not been verified "
            f"(this routine was built against {FIRMWARE_VERIFIED}); "
            "field names may differ — check the transcript"
        )

    def step(name: str, path: str, changes: dict[str, str]) -> None:
        # Once the printer has started answering with the login page, every
        # further write will too. Carrying on produces a transcript of four
        # identical failures and buries the one fact that matters.
        if result.refused:
            return
        say(f"  {name} …")
        try:
            ok, sent, body = web.submit(path, changes)
            # The session went away mid-run. It cannot be the password — login()
            # verified that against a freshly fetched settings page before any
            # of this, and raises if it is wrong. Something else took the
            # session, or the printer dropped it. Log in again and try the step
            # once more, because a setup abandoned half-applied is worse than a
            # second attempt.
            if not ok and "login page" in _explain(body):
                say("  the session went away — logging in again")
                web.login()
                ok, sent, body = web.submit(path, changes)
        except requests.RequestException as e:
            result.steps.append(Step(name, False, str(e)[:200], changes))
            return
        except RuntimeError as e:
            # The re-login itself was refused. Recorded as a refusal so the
            # caller stops rather than working through the remaining steps.
            result.steps.append(Step(name, False, f"login page: {e}", changes))
            return
        result.steps.append(Step(name, ok, "" if ok else _explain(body), sent))
        if not ok and "login page" in result.steps[-1].detail:
            say("  logging in again did not help — stopping here")

    # ---- conveniences first, while the link is definitely up -----------------
    if set_clock:
        t = now or time.localtime()
        step("set the clock", PAGE_DATE, {
            F_YEAR: f"{t.tm_year}",
            F_MONTH: f"{t.tm_mon:02d}",
            F_DAY: f"{t.tm_mday:02d}",
            F_HOUR: f"{t.tm_hour:02d}",
            F_MINUTE: f"{t.tm_min:02d}",
        })

    step("set the panel language to English", PAGE_DEVICE, {F_LANGUAGE: "3"})

    power: dict[str, str] = {}
    if auto_power_on:
        power[F_AUTO_POWER_ON] = "1"
    if disable_auto_power_off:
        # Otherwise the printer sleeps after 60 minutes idle and the first
        # person to sign in the next morning gets nothing.
        power[F_AUTO_POWER_OFF_AC] = "0"
    if power:
        step("set the power behaviour", PAGE_POWER, power)

    # Already the factory default, but stated explicitly so the outcome does not
    # depend on what state a given unit arrives in.
    step("select the wireless client role", PAGE_COMMS, {F_INTERFACE: "0"})

    # ---- WiFi last: this is what cuts the cable we are talking over ----------
    if ssid:
        if result.firmware and result.firmware not in FIRMWARE_WIRELESS_OK:
            # Warned separately from the settings pages, and immediately before
            # the write rather than at the top of the run, because this is the
            # step with no cheap undo: a wrong field here drops the wired link
            # and the way back is a factory reset.
            say(
                f"WARNING: the wireless page has never been exercised on "
                f"firmware {result.firmware} (verified on "
                f"{', '.join(sorted(FIRMWARE_WIRELESS_OK))}); if this step "
                "fails the printer may need a factory reset"
            )
        say("  joining the wireless network (the wired link will drop) …")
        # Resolve the field names from the page in front of us rather than
        # from a table captured on some other firmware. Best effort: if the
        # page cannot be read, wifi_changes falls back to the 1.32 names,
        # which is what it used to do unconditionally.
        try:
            names = wireless_fields(web.get(PAGE_WIRELESS))
        except requests.RequestException:
            names = None
        if names and names["ssid"] != F_SSID:
            say(f"  this firmware calls the SSID field {names['ssid']}, not {F_SSID}")
        changes, drop = wifi_changes(ssid, passphrase, names)
        try:
            ok, sent, _ = web.submit(PAGE_WIRELESS, changes, drop)
            result.steps.append(Step("join the wireless network", ok, "", sent))
            result.wifi_applied = ok
        except requests.RequestException as e:
            # Losing the connection here is the expected outcome, not a fault:
            # the printer is either wired or wireless, and it just switched.
            result.steps.append(
                Step("join the wireless network", True,
                     f"connection dropped while applying, which is expected ({type(e).__name__})",
                     {**changes, F_PASSPHRASE: "(redacted)"} if passphrase else changes)
            )
            result.wifi_applied = True
        say("  the printer is moving to WiFi; it will take a new IP address")

    return result


def page_text(html: str) -> str:
    """Readable text from a page, for reading tables the printer renders.

    Consecutive separators are collapsed: every tag becomes a pipe, so nested
    markup would otherwise leave runs of them between adjacent cells.
    """
    t = re.sub(r"<[^>]+>", " | ", unescape(html))
    t = re.sub(r"\s+", " ", t)
    return re.sub(r"(?:\|\s*)+", "| ", t).strip()


class _TableParser(HTMLParser):
    """Rows of cell text from every table on a page."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(re.sub(r"\s+", " ", "".join(self._cell)).strip())
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.rows.append(self._row)
            self._row = None


#: 2.4GHz has 14 channels worldwide. A cell outside this is not a channel, and
#: keying on the range is what separates a scan row from a signal strength or a
#: row number.
_CHANNELS = range(1, 15)


class _ScanParser(HTMLParser):
    """The two things on the scan page that name a network.

    Captured from a QL-820NWB on firmware 1.32, where each result row is:

        <td><input type="radio" name="lsel" value="Lobby-WiFi"/></td>
        <td><img alt="Infrastructure"><input type="hidden" name="ltyp_0" …></td>
        <td class="searchSsid">Lobby-WiFi</td>
        <td><input type="hidden" name="lch_0" value="11"/>11</td>
        …

    The radio's value is what the form itself would submit, which makes it the
    authority; the `searchSsid` cell is the same name rendered for a person to
    read. Both are collected because they fail differently — a name the page
    escapes for display would still be intact in the radio value.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.selectable: list[str] = []
        self.labelled: list[str] = []
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "input" and a.get("name") == "lsel" and a.get("value"):
            self.selectable.append(a["value"])
        elif tag == "td" and "searchSsid" in (a.get("class") or ""):
            self._cell = []

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag):
        if tag == "td" and self._cell is not None:
            name = re.sub(r"\s+", " ", "".join(self._cell)).strip()
            if name:
                self.labelled.append(name)
            self._cell = None


def _dedupe(names) -> list[str]:
    """Order preserved. The same SSID appears once per access point, and a site
    with two APs or a dual-band router lists it twice."""
    seen: set[str] = set()
    out: list[str] = []
    for name in names:
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def parse_scan(html: str) -> list[str]:
    """SSIDs out of the wireless page's scan table.

    Reads the markup the printer actually emits, with a structural fallback in
    case a different firmware lays the page out another way: a row carrying a
    name, a channel in 1..14, and a cell naming 802.11 is a scan result
    wherever it sits.

    Returns [] if nothing looks like a scan result, which callers must read as
    "no opinion" rather than "there are no networks".
    """
    scan = _ScanParser()
    try:
        scan.feed(html)
    except Exception:  # noqa: BLE001 — malformed markup is not worth a crash
        return []
    found = _dedupe(scan.selectable) or _dedupe(scan.labelled)
    if found:
        return found

    # Fallback: no recognised markup, so go by the shape of the row.
    table = _TableParser()
    try:
        table.feed(html)
    except Exception:  # noqa: BLE001
        return []
    out: list[str] = []
    for row in table.rows:
        if len(row) < 3:
            continue
        channel = any(c.isdigit() and int(c) in _CHANNELS for c in row[1:])
        mode = any("802.11" in c or re.search(r"\b\.?11[abgn]", c) for c in row)
        if not (channel and mode):
            continue
        name = next((c for c in row if c), "")
        # A header row can otherwise satisfy the shape test.
        if not name or name.lower() in ("ssid", "name", "network"):
            continue
        out.append(name)
    return _dedupe(out)


def visible_networks(web: PrinterWeb) -> list[str]:
    """SSIDs the printer can currently see, in the order it lists them.

    This is the only trustworthy source for a network picker. The printer is
    2.4GHz (802.11b/g/n), so a 5GHz network never appears here — which means a
    list taken from a phone or a Pi can offer a choice the printer is unable to
    join, and joining is the step that cannot be undone without a factory reset.

    Returns an empty list if the scan cannot be read. Callers must treat that
    as "no opinion" rather than "nothing there": the operator may well be
    setting the printer up somewhere other than where it will live.
    """
    try:
        return parse_scan(web.get(PAGE_WIRELESS_SCAN))
    except requests.RequestException:
        return []


def wireless_active(ip: str, timeout: float = 5.0) -> bool | None:
    """Is the wireless interface up? The 'safe to unplug Ethernet' signal.

    Returns None if the printer cannot be reached at all.
    """
    try:
        r = requests.get(f"http://{ip}{PAGE_NETSTATUS}", timeout=timeout)
        r.raise_for_status()
    except requests.RequestException:
        return None
    text = re.sub(r"<[^>]+>", "|", unescape(r.text))
    text = re.sub(r"\s+", " ", text)
    m = re.search(r"IEEE\s*802\.11[^|]*\|+\s*\(?(Active|Inactive)\)?", text)
    return (m.group(1) == "Active") if m else None


def main() -> int:
    """Configure a printer from the command line.

    The web-UI password is the code printed on the back of the printer. It is
    read from the environment rather than an argument so it does not end up in
    shell history or a process list:

        PRINTER_WEB_PASSWORD=xxxx ./venv/bin/python printer_config.py 192.168.1.27
        PRINTER_WEB_PASSWORD=xxxx PRINTER_WIFI_PASSPHRASE=yyyy \\
            ./venv/bin/python printer_config.py 192.168.1.27 --ssid "Lobby-WiFi"
    """
    import argparse
    import os

    ap = argparse.ArgumentParser(description="Configure a Brother QL-820NWB for kiosk use.")
    ap.add_argument("ip", help="the printer's current address (on Ethernet)")
    ap.add_argument("--ssid", help="wireless network to join — applied LAST, drops the wired link")
    ap.add_argument("--no-clock", action="store_true", help="leave the printer's clock alone")
    args = ap.parse_args()

    password = os.environ.get("PRINTER_WEB_PASSWORD", "")
    if not password:
        print("set PRINTER_WEB_PASSWORD to the code on the back of the printer", file=sys.stderr)
        return 2

    try:
        result = configure_printer(
            args.ip,
            password,
            ssid=args.ssid,
            passphrase=os.environ.get("PRINTER_WIFI_PASSPHRASE") or None,
            set_clock=not args.no_clock,
            log=lambda m: print(m, flush=True),
        )
    except Exception as e:  # noqa: BLE001 - the operator wants the reason, not a traceback
        print(f"could not configure the printer: {e}", file=sys.stderr)
        return 1

    print()
    print(result.transcript())
    print()
    if not args.ssid:
        return 0 if result.ok else 1

    # The printer is now moving to WiFi. It keeps answering on Ethernet until
    # the cable comes out, which is the only window in which we can ask it
    # whether the wireless side came up.
    import discover

    print("Waiting for the wireless interface to come up …")
    up = wait_for_wireless(args.ip, log=lambda m: print(m, flush=True))
    if not up:
        print()
        print("The wireless interface has not come up. The printer is still on Ethernet,")
        print("so nothing is lost — check the SSID and passphrase and run this again.")
        return 1

    print("Wireless is up. It is now safe to unplug the Ethernet cable.")
    mac = result.wireless.mac
    if not mac:
        print("(Could not read the wireless MAC, so the new address must be found by hand.)")
        return 0

    name = discover.node_name_for(mac)
    print()
    print(f"After unplugging, the printer answers to {name}.local on a NEW address.")
    print("Looking for it now (this only succeeds once the cable is out) …")
    found = discover.find_printer(mac=mac)
    if found:
        print(f"  found at {found.ip} via {found.via}"
              + (f" — {found.model}" if found.model else ""))
        print(f"  set this printer's address to {found.ip} in the admin.")
    else:
        print(f"  not found yet — that is expected while Ethernet is still connected.")
        print(f"  once unplugged, run:  ./venv/bin/python discover.py --mac {mac}")
    return 0 if result.ok else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
