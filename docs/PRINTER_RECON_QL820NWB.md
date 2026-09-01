# QL-820NWB web-UI recon — captured from a factory-reset unit

Raw findings behind `configure_printer()` (MULTI_TENANT_DESIGN.md §17). Captured
by driving the printer's web UI directly and reading the resulting requests.

| | |
|---|---|
| Model | QL-820NWB |
| Serial | B6G868653 |
| **Firmware** | **1.32** |
| Memory | 7MB |
| Total print length | 0 m (confirms never used) |
| UI copyright | 2000–2016 |
| Address during capture | `http://192.168.1.27/` (Ethernet) |

Firmware 1.32 is the version every field name below is keyed to. Treat a
different firmware as unverified until re-checked — that is the whole reason
this file records the version so prominently.

---

## A0. Firmware versions seen in the field

The whole of this document was reverse-engineered against **firmware 1.32**.
`FIRMWARE_VERIFIED` in `printer_config.py` records that, and `configure_printer`
warns when it meets anything else.

| Firmware | Seen on | Behaviour |
|---|---|---|
| 1.32 | the recon printer | everything here is confirmed against it |
| 1.23 | a printer at Temple Beth El, 2026-09-01 | accepted the web password, then answered a later write with the login page — the session did not survive the run |

**1.23 is older than 1.32, not newer.** A device that has never been updated is
the normal case, not the exception, so an unverified firmware should be
expected rather than treated as a surprise. What is not yet known is whether
1.23 names fields differently, handles the session differently, or objects to a
field the newer UI accepts — the transcript from a failed run is the place to
look, and `firmware_observations` now keeps the outcome of a refused run so the
pattern is visible across a fleet.

## A. Session and authentication

Login is a **password-only** form (no username), posted to **the page's own
URL** rather than a dedicated endpoint:

| Field | Meaning |
|---|---|
| `B128` | the password (the code printed on the back of the printer) |

> **The login field name is not stable across firmware.** 1.32 calls it
> `B128`; 1.23 (observed on serial C0Z851372, 2026-08-31) calls it `B126`.
> Do not hardcode either — `_login_form()` reads it off the page by finding
> the input of `type="password"`.
>
> **The wireless page is shifted by the same two.** On 1.23 the SSID is
> `Bdc` (not `Bde`), the passphrase `Bf6` (not `Bf8`), the network-key index
> `Be4` (not `Be6`) and the WEP keys `Be6/Bea/Bee/Bf2` (not
> `Be8/Bec/Bf0/Bf4`) — while `B62`, `B63` and `B64` below them are unchanged.
> 1.32 evidently inserted a field between them. The option *values* did not
> move: 1.23's `wireless.js` also builds `new Option(WPA_WPA2, 3)` and
> `new Option(AES, 4)`.
>
> `wireless_fields()` resolves these from the label printed beside each
> control, which is stable across both. Captured page:
> `bridge/testdata/wireless_fw1.23.html`.
>
> Verified on 1.23 (serial C0Z851372, 2026-08-31): once the login field is
> read off the page, every settings field matches 1.32 exactly — `B28`,
> the power fields and the comms fields all took. The wireless page has
> *not* been exercised on 1.23; that run was made without `--ssid`.
>
> This mattered more than a renamed field usually would. Posting `B128` to
> 1.23 meant the printer never received a password, and the check that was
> supposed to catch a failed login also looked for `B128`, did not find it,
> and reported success. The result was an unauthenticated session that
> appeared healthy: every settings write came back as the login page and was
> diagnosed as a dropped session, while `/general/date.html` — which needs no
> login on this firmware — accepted its write and set the clock.
| `loginurl` | path to return to after login, e.g. `/general/status.html` |
| `CSRFToken` | see below |

**Every form on the device carries a `CSRFToken`**, and it is regenerated on
each page load. So the automation shape is fixed:

1. `GET` the page → scrape `CSRFToken` (and the current value of every field)
2. `POST` back to the same URL with the token, the page's `pageid`, and **all**
   the fields — not just the one being changed
3. Confirm success by **reading the page back** and checking the values took.
   `<div class="postSuccess">Submit OK</div>` appears on most pages but **not
   on the wireless page**, which stores its settings and says nothing — so
   trusting the marker reports failure on a write that plainly worked. Secrets
   are never echoed back, so a passphrase cannot be verified this way.

A plain cookie jar plus an HTML scrape is enough; no JavaScript execution is
required for any of the four settings. Three details are not optional, all
found the hard way when every write silently failed:

1. **Submit only the target form.** Every page carries a **logout form in its
   header**, and its hidden `B129` riding along in a settings POST makes the
   printer treat the request as a logout: the change is dropped and the
   response carries no success marker. Scope the scrape to the form whose
   `action` matches the page — noting the device writes the same form's action
   both absolutely (`/net/wireless/wireless.html`) and relatively
   (`wireless.html`).

2. **Normalise the CSRF token's newlines to CRLF.** The token is wrapped across
   several lines inside the `value` attribute. A browser normalises those to
   CRLF when submitting; sending the raw LF that an HTML parser hands you is a
   different byte string.

3. **Send browser-ish headers** — a real `User-Agent` and a `Referer` for the
   page being posted.

Points 2 and 3 were applied together and the writes started working, so it is
not established which of them mattered — the CRLF normalisation is the more
likely culprit, but that is inference. Anyone shortening this should retain
both until they have evidence to drop one.

Labels in the markup use numeric entities (`Model&#32;Name`), so unescape
before matching any of them.

## Page map

| Page | Path | `pageid` |
|---|---|---|
| Status | `/general/status.html` | 1 |
| Maintenance Information | `/general/information.html?kind=item` | — |
| Power Settings | `/printer/power_settings.html` | 158 |
| **Device Settings** | `/printer/device_settings.html` | 159 |
| P-touch Template | `/printer/ptouch_template.html` | — |
| Communication Settings | `/printer/communication_settings.html` | — |
| Wi-Fi Protected Setup | `/printer/wps.html` | — |
| Administrator (password) | `/admin/password.html` | — |
| Network | `/net/net/net.html` | — |

---

## 1. Forms mode → off  ✅ captured and applied

**This is the setting that matters most, and the factory default is wrong for
us.** The status page reports `Emulation: P-touch Template` out of the box,
which is why raster printing and status queries do not work until it is changed.

- **Page:** `/printer/device_settings.html` (`pageid=159`)
- **Field:** `B24` — Command Mode
  - `20` = ESC/P
  - **`21` = Raster** ← what the bridge needs
  - `22` = P-touch Template ← **factory default**

Applied `B24=21`; the response contained `Submit OK` and the status page then
reported `Emulation: Raster`.

**Confirmed:** the setting survives a hard power cut (the cord was pulled and
the page still reported Raster afterwards).

**Not confirmed: whether the printer is actually in raster mode.** A status
request on port 9100 goes unanswered both before and after a power cycle — but
that proves nothing here, because `bridge/printer.py` already documents this
model as one that *"doesn't answer the status request even though printing
works fine"*. An earlier draft of this document treated that timeout as
evidence that settings need a reboot to take effect; that was wrong, and the
claim is withdrawn.

> **The only trustworthy test of command mode on this model is an actual
> print.** `configure_printer()` should verify by printing, not by a status
> query and certainly not by reading the web UI back.
>
> A side-effect worth knowing: because this printer does not answer status
> requests, the bridge will report its media type and width as unknown, and the
> admin Status panel will show blanks for it. That is cosmetic — printing is
> unaffected — but it means media detection cannot be relied on for these
> units.

Other fields on this page that must be posted back unchanged (with their
factory values):

| Field | Meaning | Default |
|---|---|---|
| `B2b` / `B2c` | Print density black / red | `6` (= 0) |
| `B25` | Print information report contents | `3` (All) |
| `B26` | Serialize mode | `1` (Cont From Last) |
| `B2e` | Default print quantity | `1` |
| `B21` | Print data after printing | `0` (Keep) |
| `B28` | Language | `3` (English) |
| `B29` | Display brightness | `2` (0) |
| `B2f` | Backlight | `1` (On) |
| `B2a` | Backlight timeout | `2` (10s) |
| `B30` | Auto cut | `0` (Auto Cut) |

---

## 4. Auto power-on  — fields identified

- **Page:** `/printer/power_settings.html` (`pageid=158`)
- **Field:** `B1c` — Auto Power On: `0` = Disable (**factory default**),
  `1` = Enable

| Field | Meaning | Default |
|---|---|---|
| `B1c` | Auto Power On | `0` Disable |
| `B1d` | Auto Power Off (AC/DC) | `6` = **60 Mins** |
| `B1e` | Auto Power Off (Li-ion) | `6` = 60 Mins |
| `B23` | Eco Charging | `0` = 100% |

> **Finding not on the original checklist:** `B1d` defaults to **60 minutes**.
> A lobby kiosk printer left idle would power itself off after an hour and the
> first person to sign in that morning would get nothing. `configure_printer()`
> should set `B1d=0` (None) alongside `B1c=1`.

---

## Language / date / time — the first-boot wizard

A factory-reset unit asks for these at the panel before it will do anything.
Both are settable over the web UI, so `configure_printer()` can answer the
wizard remotely.

- **Language:** `B28` on `/printer/device_settings.html` — already `3` (English)
  by default. Set it explicitly anyway; it costs nothing and makes the outcome
  independent of what the panel was left on.
- **Date & Time:** `/general/date.html` (`pageid=10`)

| Field | Meaning |
|---|---|
| `B3e` | Year (`2026`) |
| `B3f` | Month (`08`) |
| `B40` | Day (`23`) |
| `B41` | Hour, 24-hour (`13`) |
| `B42` | Minute (`24`) |
| `B3d` | Hidden epoch seconds |

The page pre-fills from the *browser's* clock via JavaScript, not from the
printer's RTC — so the automation simply posts the Pi's current time. Applied;
`Submit OK`, no reboot.

---

## 2. WiFi Infrastructure mode — already correct out of the box

Two separate settings are involved, on two different pages, and it is worth
being precise about which does what.

**a. The radio's role** — `/printer/communication_settings.html` (`pageid=161`)

| Field | Meaning | Default |
|---|---|---|
| `B32` | Selected Interface: `0` Infrastructure or Adhoc, `1` Infrastructure and Wireless Direct, `2` Wireless Direct | `0` |
| `B31` | Network Settings on Power On: `0` On, `1` Off, `2` Keep Current State | `2` |

> **`B31=2` is why a correctly configured radio can still never come up**, and
> **`B31=0` only takes effect at the next power-up** — the field is called
> "Network Settings on Power On" and means it literally.
>
> Confirmed on hardware: with SSID, WPA/WPA2-PSK, AES and passphrase all stored
> and visible on the wireless page, the interface stayed `inactive` with
> `Channel 0` and no receiving signal. Setting `B31=0` changed nothing
> immediately. A power cycle brought the radio straight up, and the printer
> joined the network.
>
> The printer's **own WiFi icon** is the indicator to trust here. Across every
> attempt before this, it never lit — which was the clearest signal that the
> problem was an enable rather than the credentials, well before the web UI
> admitted anything was wrong.
| `B15e` | hidden | `1` |

`0` already means "act as a client", so no change is needed. Note that while
`B32=0`, **Wireless Direct's own configuration page is not exposed in the menu
at all** — which is what makes the client page below easy to mistake for an AP
page.

**b. The connection itself** — `/net/wireless/wireless.html` (`pageid=217`;
the form's `action` is the relative `wireless.html`)

- **Field:** `B62` — Communication Mode: **`1` = Infrastructure**, `2` = Ad-hoc,
  factory default `1`.

> **This page is the client (station) configuration, not the access point.**
> It is genuinely confusing: the SSID field is pre-filled with
> `QL-820NWB_68653`, which reads like a broadcast name. It is only a
> placeholder. The proof is the **Browse** button — `GET wireless.html?wlan=3`
> returns a **scan of nearby access points** with channel and signal strength,
> which is something only a client would offer. `Bde` is the network the
> printer will *join*.

The scan endpoint is also useful in its own right: a guided wizard could show
the operator a live list of visible networks instead of asking them to type an
SSID.

## 3. WiFi SSID + passphrase — fields identified, NOT applied

Same page. Out of the box the radio reports SSID `QL-820NWB_68653`,
Authentication `Open System`, Encryption `None`.

| Field | Meaning | Default |
|---|---|---|
| `B62` | Communication Mode | `1` Infrastructure |
| `Bde` | Wireless Network Name (SSID) | `QL-820NWB_68653` |
| `Be2` | Channel | `11` |
| `B63` | Authentication Method | `1` Open System — set **`3`** for WPA/WPA2-PSK |
| `B64` | Encryption Mode | `1` None, `2` WEP (only relevant to Open/Shared) |
| `Bf8` | **WPA passphrase** | — |
| `Be6` / `Be8` `Bec` `Bf0` `Bf4` | WEP key selector and keys 1–4 | not used for WPA |
| `wlan` | hidden | `2` |

For a WPA2 network: `B62=1`, `B63=3`, **`B64=4`**, `Bde=<ssid>`,
`Bf8=<passphrase>` — **and omit `Be6`, `Be8`, `Bec`, `Bf0`, `Bf4`.**

> **The static page does not tell you this, and getting it wrong is silent.**
> The rules live in `/common/js/wireless.js`, which the page loads:
>
> * Choosing WPA/WPA2-PSK **replaces** the encryption choices with `3=TKIP`
>   and `4=AES`. Neither appears in the page as served — it offers only
>   `1=None | 2=WEP` — so scraping the form and leaving the field alone posts
>   `B64=1`, a combination the printer will not accept. **AES (`4`) is the one
>   for WPA2.**
> * The same script **disables** the WEP key fields unless the encryption mode
>   is WEP, and disables the passphrase unless the method is WPA/WPA2-PSK. A
>   browser does not submit disabled controls, so neither should an automation.
>
> Both facts were found by reading that script after a dry run showed `B64`
> offering only None and WEP. The JS is fetchable without logging in, which
> makes it the authority on any of this page's couplings.

### The Browse button — a site survey, captured

`GET /net/wireless/wireless.html?wlan=3` returns the printer's own scan of
nearby access points. **Confirmed against hardware** (firmware 1.32,
2026-08-24), and it needs a logged-in session like the rest of the UI.

This is the right source for a network picker, and the only trustworthy one:
the printer is 2.4GHz (802.11b/g/n), so a list it produced itself cannot offer
a network it is unable to join. A list from a phone or from the bridge can, and
choosing a 5GHz network fails exactly the way a wrong passphrase does.

Each result row looks like this — the names below are substituted, the markup
is verbatim:

```html
<tr><td><input type="radio" name="lsel" value="Example-2G"/></td>
<td><img src="../../common/images/ap.gif" alt="Infrastructure" /><input
    type="hidden" name="ltyp_0" id="ltyp_0" value="1" /></td>
<td class="searchSsid">Example-2G</td>
<td><input type="hidden" name="lch_0" id="lch_0" value="11" />11</td>
<td>.11b/g/n</td>
<td>***</td></tr>
```

Four things worth knowing before parsing it:

- The **`lsel` radio value** is the name the form itself would submit, which
  makes it the authority. `td.searchSsid` is the same name rendered to read.
- The Wireless Mode cell is **`.11b/g/n`**, not `802.11b/g/n`. The `802` is
  absent from the markup entirely.
- **One row per access point**, so a site with two APs — or a dual-band router
  — lists the same SSID more than once. The row for the currently-associated
  network carries `checked="checked"`.
- A **second table** follows, for adding a network by hand. Its channel
  dropdown lists every channel there is, so anything matching on "a cell
  holding a channel number" will read that form as a result unless it is
  excluded.

Signal strength is rendered as asterisks (`***`, `*`), not a number.

Parsed by `printer_config.parse_scan()`, with the captured page as a fixture in
`bridge/test_printer_config.py`.

---

## Rebooting — there is no clean way to do it remotely

The Administrator → Reset Menu (`/admin/default.html`, `pageid=149`) offers only
two actions, both destructive:

| Field | Action |
|---|---|
| `btn_def=2` | Network reset |
| `btn_def=6` | Factory reset |

There is **no plain reboot**. Whether a power cycle is even required is now
open (see the note under setting 1), but if one is wanted, it cannot be
triggered from the web UI. Two routes:

- **Auto Power On (`B1c=1`) plus a smart plug.** Auto Power On means "come up
  when AC is applied", so cutting and restoring power should bring the printer
  back unattended. This is the only fully remote option.

  > **It works — but only with the Ethernet cable unplugged.**
  >
  > With Ethernet connected, `B1c=1` had no effect across repeated power
  > cycles: the printer stayed dark until its button was pressed. Unplug the
  > cable and the same power cycle brings it up by itself. Brother document
  > that the auto power *off* features are suppressed while the printer holds
  > an active wired, wireless or Bluetooth connection; the auto power *on*
  > behaviour appears to be affected by the same link state.
  >
  > (This unit had been running in the lobby for weeks beforehand with auto
  > power on working, which is what prompted looking past "the setting is
  > broken" — it never was.)
  >
  > **What this means for provisioning:** auto power on cannot be relied on
  > during the Ethernet-attached configuration phase, which is exactly when a
  > reboot is wanted. It becomes available once the printer is on WiFi and the
  > cable is gone — i.e. in normal running, where it matters for recovering
  > from a power cut. Plan the configuration reboot as a button press, and
  > treat auto power on as a property of the deployed state rather than the
  > provisioning state.
  >
  > Boot takes roughly 90 seconds to a couple of minutes either way.

## Factory reset — required, and it comes first

Provisioning starts from a factory reset, **before the Ethernet cable goes in**,
whether or not the printer looks fine.

Two reasons, and the second is the stronger one:

* If a previous owner changed the web-UI password, there is no way in — and no
  way to trigger a reset over the web either, since that screen is behind the
  same login. The reset restores the code printed on the back.
* Even with access, a used printer carries hundreds of settings nobody has
  enumerated. Resetting is the only way to reach a state this tooling has been
  tested against. Automating a reset for the reachable case would add a branch
  that still leaves the outcome unknown.

On the printer's own screen:

```
1.  Menu
2.  Up / Down   until you reach  Administration
3.  OK          to enter it
4.  Up / Down   until you reach  Reset
5.  OK
6.  OK          to choose  Factory Reset
7.  OK          again to confirm
```

> **Do not power the printer down while it is resetting.**

### The first-run wizard, which must be finished before anything else

A reset printer comes up in a setup wizard asking for a **language**, then a
**date and time**. It has to be worked through on the panel:

- choose the language
- press OK through the date and time, leaving the defaults (they read 2017)

> **It does not go away on its own.** Switching the printer off and on returns
> to the same screen, and until it is complete the printer never reaches its
> home screen.
>
> **Finishing it overwrites the clock**, so it must be done *before* anything
> configures the printer — otherwise the date this tooling sets is silently
> replaced by the wizard's default. Observed: the clock was configured over the
> network while the printer sat in the wizard, and completing the wizard
> afterwards undid it. Every other setting survived.

The printer's web UI answers *during* the wizard, so its reachability is not a
signal that the wizard is done. There is no way to detect this over the
network — it has to be an instruction.

Once the wizard is finished, the printer takes an address from Ethernet and
becomes discoverable. **Measured: about 90 seconds** from confirming the
factory reset to the printer answering on the wired network.

## The WiFi cutover, as it actually works

Confirmed end to end on hardware:

1. Over Ethernet, set **`B31=0`** on `/printer/communication_settings.html` —
   the wireless LAN will start at the next power-up.
2. Apply the network on `/net/wireless/wireless.html`: `B62=1`, `Bde=<ssid>`,
   `B63=3`, `B64=4`, `Bf8=<passphrase>`, omitting the WEP fields.
   **Nothing observable happens.** The page stores the settings, emits no
   success marker, and the radio stays down.
3. **Turn the printer off and on with its button.** Auto power on does not
   work while Ethernet is connected, so pulling the cord leaves it off.
4. Watch the **WiFi icon on the printer's screen** and wait for it to become
   **solid** — about 15 seconds in practice, allow 30.

   > The icon is the only trustworthy signal at this point. A radio that never
   > associates leaves every web page reporting the settings as correct, since
   > they *are* stored — what has failed is the join. **An icon that never goes
   > solid means the passphrase is wrong**, not that the configuration failed.
   > The printer is still reachable over Ethernet, so re-running just the
   > wireless step with the right passphrase is enough; there is no need to
   > start from a reset.
5. The printer is now on a **different IP**, because the wireless interface has
   its own MAC and its own DHCP lease. Find it by its wireless MAC:
   `discover.py --mac <wireless-mac>`, which resolves `BRW<mac>.local`.

Observed on the test unit: `192.168.1.27` wired → `192.168.1.69` wireless,
found over mDNS on the first attempt.

## What `configure_printer()` actually has to do

After testing, the original four-setting list reduces considerably:

| Original setting | Verdict |
|---|---|
| 1. Forms mode → off | **Not needed.** Every job switches to raster itself. |
| 2. WiFi Infrastructure mode | **No-op.** `B32=0` and `B62=1` are already the factory defaults; set them explicitly for certainty, but nothing changes. |
| 3. WiFi SSID + passphrase | **Genuinely required.** `Bde`, `B63=3`, `Bf8`. |
| 4. Auto power-on | **Worth setting** (`B1c=1`), though it only takes effect once the printer is off Ethernet. |

Worth adding, none of which were on the original list:

- `B1d=0` — auto power off, otherwise 60 minutes
- Date, time and panel language, so the first-boot wizard is answered remotely

So the automation is essentially **"join this WiFi network, and set a handful of
conveniences"** — much less than the recon set out to build, because the setting
that looked hardest turned out to be unnecessary.

## Boot time

**~2 minutes from power-on until the printer answers on the network** (wired).
Anything that reboots the printer and then polls for it needs a timeout well
past that, and a progress message — two minutes of silence looks like a failure
to an operator standing there.

## Command mode may not need configuring at all

`brother_ql` puts a **dynamic command-mode switch** in every job preamble:

```
00 00 1b 40 1b 69 61 01
        ESC @  ESC i a 01   <- switch this connection to raster
```

So each print job asks the printer to be in raster mode *for that connection*,
whatever its stored default. If that works, the persistent `B24` setting — and
the separate form/template mode visible on the front panel — do not matter for
**printing**. They would only matter for status queries, which this model
ignores regardless.

**TESTED ON HARDWARE — IT WORKS.** A test badge was rendered and sent through
the bridge's own `print_image()` while the front panel still showed form mode,
and **the label printed**. The dynamic switch is sufficient: the printer's
stored command mode and its panel form mode are both irrelevant to printing.

Two things follow:

1. **Setting 1 comes off the automation list.** It was the hardest of the four,
   the only one the web UI cannot fully reach (a sweep of every page found
   `Command Mode` and nothing else mode-related), and it turns out not to be
   needed. It affects only status queries, which this model does not answer
   regardless.
2. `_relax_media_validation()` in `bridge/printer.py` earns its keep — the job
   went through with 62mm-continuous geometry on a 60x86 die-cut roll, which
   the printer would otherwise have rejected as the wrong media.

The print was misaligned to the label borders, as expected: a 1063 x 696 dot
image sized for a 62mm endless roll does not fit an 86mm die-cut badge. That is
geometry, not command mode.

## D. Apply behaviour and the "safe to unplug" signal

`/net/net/net.html` reports each interface separately, with an explicit state:

```
Wired     Ethernet 10/100BASE-TX   (Active)    MAC 94-dd-f8-ac-36-45
Wireless  IEEE 802.11b/g/n         (Inactive)  MAC 44-f7-9f-bc-ab-e8
```

That `(Active)` / `(Inactive)` is the field to poll for "WiFi is up, safe to
unplug Ethernet".

**The two interfaces have different MAC addresses and different node names**
(`BRN…` wired, `BRW…` wireless), so they take **different DHCP leases**. The
printer's IP therefore *changes* when it moves to WiFi — the bridge cannot keep
using the Ethernet address, and has to rediscover it (mDNS, phase B2) or read
the new one from the wireless TCP/IP page before the cable comes out.

### Ordering constraint for `configure_printer()`

The printer is documented as **either wired or wireless, not both** — but that
is looser in practice than it sounds. Observed after a cutover: the WiFi icon
lit on the panel, the printer answered at its **wireless** address, and the
**Ethernet cable was still connected**. So the wireless side comes up without
waiting for the cable to be removed, and there is no need to unplug anything
before confirming the move worked.

That simplifies the handover: verify over the network, *then* tell the
installer to unplug Ethernet and power and move the printer to where it will
live. Applying the WiFi settings may still drop the wired link mid-request, so:

1. Command Mode → Raster
2. Language, date, time
3. Auto power on / auto power off
4. **WiFi last**, and losing the connection immediately afterwards is the
   *expected* outcome, not a failure. The routine must not treat the dropped
   request as an error, and must reconnect by discovery rather than by the old
   address.

---

## Applied to this unit during recon

| Setting | From | To |
|---|---|---|
| Command Mode (`B24`) | P-touch Template | **Raster** |
| Date & time | — | current |
| Auto Power On (`B1c`) | Disable | **Enable** |
| Auto Power Off AC/DC (`B1d`) | 60 Mins | **None** |

WiFi was deliberately left untouched.
