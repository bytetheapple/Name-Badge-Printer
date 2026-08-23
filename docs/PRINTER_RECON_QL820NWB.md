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
reports Raster. **No reboot, no link drop** — the change is immediate.

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

## Still to capture

- 2. WiFi Infrastructure mode
- 3. WiFi SSID + password (throwaway credentials only)
- D. reboot/apply behaviour, and the field reporting WiFi state + IP
