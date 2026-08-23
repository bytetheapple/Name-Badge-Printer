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

## A. Session and authentication

Login is a **password-only** form (no username), posted to **the page's own
URL** rather than a dedicated endpoint:

| Field | Meaning |
|---|---|
| `B128` | the password (the code printed on the back of the printer) |
| `loginurl` | path to return to after login, e.g. `/general/status.html` |
| `CSRFToken` | see below |

**Every form on the device carries a `CSRFToken`**, and it is regenerated on
each page load. So the automation shape is fixed:

1. `GET` the page → scrape `CSRFToken` (and the current value of every field)
2. `POST` back to the same URL with the token, the page's `pageid`, and **all**
   the fields — not just the one being changed
3. Confirm success by looking for `<div class="postSuccess">Submit OK</div>`

A plain cookie jar plus an HTML scrape is enough; no JavaScript execution is
required for any of the four settings.

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

For a WPA2 network: `B62=1`, `B63=3`, `Bde=<ssid>`, `Bf8=<passphrase>`.

There is also a **Browse** button that scans for nearby APs — not needed for
automation, but it exists if a guided wizard ever wants to offer a picker.

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

**This is the single most valuable thing left to test**, because it would
remove the hardest setting from the automation entirely. It is also the one
setting the web UI cannot fully reach: a sweep of every page found `Command
Mode` and nothing else mode-related, so if the panel exposes a separate form
mode, it is not web-configurable and `configure_printer()` could never have
handled it anyway.

**Blocked on media.** The unit arrived with DK-1234 (60mm x 86mm die-cut name
badge) loaded, and `brother_ql` has no spec for that size — it knows `62`
continuous plus a fixed set of die-cuts, none of them 60x86. A print attempt on
the current roll would most likely fail on media mismatch and tell us nothing
about command mode. **Load a 62mm continuous roll (what the deployment uses)
before testing.**

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

The printer is **either wired or wireless, not both**. When the automation is
running over Ethernet, applying WiFi settings cuts the link it is using — so:

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
