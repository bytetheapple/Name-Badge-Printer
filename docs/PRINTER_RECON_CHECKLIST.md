# Printer Web-UI Recon Checklist (QL-820NWB)

One-pass capture of the printer's web interface so we can build the bridge's
`configure_printer()` automation (see `MULTI_TENANT_DESIGN.md` §17). Do this on a
**factory-fresh printer** if possible, so we see the real out-of-box state
(e.g. it arriving in Forms mode).

The four settings we need to automate:
1. **Forms mode → off** (raster/command mode)
2. **WiFi → Infrastructure mode**
3. **WiFi SSID + password**
4. **Auto power-on after outage**

> **Safety:** when sharing captures, **redact your real WiFi password** — or do
> the WiFi step against a **throwaway SSID/password** so nothing sensitive is in
> the transcript.

---

## A. Get on the printer's web UI

- [ ] Connect the printer to the LAN by **Ethernet**, power it on.
- [ ] Find its IP (your router's client list, or the printer's own network-info
      printout). Record it: `http://<printer-ip>/`
- [ ] Open that URL in a browser. Note the **login mechanism**:
  - [ ] Is a password required? What/where is the default (label? serial? `initpass`?)
  - [ ] After login, is there a **CSRF token** in forms or a **session cookie**?

## B. Capture identity (for firmware-keyed profiles)

- [ ] **Model**, **firmware version**, **serial** — screenshot the info/maintenance page.
- [ ] Optional headless check from any machine on the LAN:
      `snmpget -v2c -c public <printer-ip> 1.3.6.1.2.1.1.1.0`  (sysDescr)

## C. Capture each of the 4 settings

For **each** setting, the goal is the exact request the printer makes when you
save it. Easiest method — browser **DevTools → Network**:

- [ ] Open DevTools → **Network** tab → enable **Preserve log**.
- [ ] Change the setting in the web UI and click **Save/Submit**.
- [ ] Find the resulting **POST** request → right-click → **Copy → Copy as cURL**.
- [ ] Also **Save** (or "Copy as cURL") the **GET** of that settings page (shows
      field names, current values, any CSRF token).

Capture in this order and label each:

- [ ] **1. Forms mode → off** — GET page + POST (Copy as cURL)
- [ ] **2. WiFi Infrastructure mode** — GET page + POST
- [ ] **3. WiFi SSID + password** — GET page + POST *(use a throwaway SSID/pw)*
- [ ] **4. Auto power-on after outage** — GET page + POST

## D. Capture apply/reboot behavior

- [ ] Does saving WiFi **reboot** the printer or drop the link? Roughly how long
      until WiFi is up?
- [ ] With **both** Ethernet and WiFi connected, does it keep using Ethernet? Does
      the web UI show a **separate WiFi IP / "connected" status** we can poll to
      confirm "safe to unplug Ethernet"?
- [ ] Which URL/field reports the **WiFi interface state + IP**? (We'll use it for
      the "on WiFi" confirmation.)

## E. Send me

- [ ] The `http://<printer-ip>/` URL + login method/default.
- [ ] Model / firmware / serial screenshot.
- [ ] For each of the 4 settings: the **GET page HTML** and the **Copy-as-cURL**
      of the POST (WiFi password redacted).
- [ ] Notes from section D (reboot timing, WiFi status URL/field).

With that, I'll write `configure_printer()` (an HTTP session that logs in and
drives those four forms), plus the transcript logging, firmware detection, and the
WiFi-reachability "safe to unplug" check.
