# Print Bridge

A small Python service that runs on a device on the **same LAN as the Brother
QL-820NWB** (a Raspberry Pi). It polls Supabase for queued print jobs, renders
each badge, and sends it to the printer over TCP port 9100. It also writes a
heartbeat + printer-status row so the admin console can show connectivity and
media state.

## How it works

```
Supabase print_jobs (queued)  --poll every 2s-->  bridge
                                                    |  claim (atomic)
                                                    |  render badge (Pillow)
                                                    |  brother_ql -> raster
                                                    v
                                        Brother QL-820NWB (TCP 9100)
```

- **Polling, not websockets** — simpler and more robust on a Pi; 2s latency is
  imperceptible for badge printing.
- **Atomic claim** — `UPDATE ... WHERE status='queued'` so a job is never printed
  twice, even if two bridges ran.
- **Auth** — an opaque **bridge token** (`BRIDGE_TOKEN` in `bridge/.env`) that
  scopes the device to a single organization. The bridge talks only to the
  `bridge-poll` / `bridge-complete` Edge Functions; the server decides what it
  may see. A lost SD card exposes one congregation, not the whole platform.
  The old `service_role` key still works if no token is set, so a Pi can be
  upgraded and cut over separately — but it bypasses RLS and reaches every
  tenant, so retire it as soon as the token works.
- **One call per tick** — `bridge-poll` carries the heartbeat, the printer status
  report, the org's config and printers, and the next (already claimed) job.

## Files

| File | Purpose |
|------|---------|
| `bridge.py` | Main loop: poll, print, report |
| `client.py` | Server conversation: bridge token (preferred) or legacy `service_role` |
| `db.py` | Tiny PostgREST client, used only by the legacy path |
| `test_client.py` | Offline tests for both backends (no Supabase, no printer) |
| `printer_config.py` | Configure a QL-820NWB over its web UI (see below) |
| `discover.py` | Find a printer on the LAN after it moves to WiFi |
| `test_printer_config.py` | Offline tests for that, against a stub of the printer's web UI |
| `test_discover.py` | Offline tests for discovery (no printer, no network) |
| `badge.py` | Render a badge to a PIL image (also runnable standalone) |
| `printer.py` | brother_ql send + TCP reachability + status parse |
| `config.py` | Env configuration |
| `systemd/` | Service unit for auto-start on boot |
| `scripts/install.sh` | venv + dependency setup |

## Setup on the Raspberry Pi

```bash
git clone <repo> ~/name-badge-printer
cd ~/name-badge-printer/bridge
./scripts/install.sh
cp .env.example .env      # then fill in BRIDGE_TOKEN
./venv/bin/python bridge.py   # test run
```

Issue the token in the admin under **Printer → Print servers**. It is shown once.
On start-up the bridge logs which credential it is using:

```
[...] bridge starting; auth: bridge token; polling every 2.0s
```

If it says `service_role (deprecated)` it is still on the old key and will warn.

### Cutting an existing Pi over

```bash
cd ~/name-badge-printer && git pull
cd bridge && ./venv/bin/python test_client.py   # offline sanity check
nano .env                                        # add BRIDGE_TOKEN, comment out the service_role line
sudo systemctl restart name-badge-bridge
journalctl -u name-badge-bridge -n 20            # confirm "auth: bridge token"
```

Both credentials may be present during the change-over; the token wins. Once the
log shows the token in use, delete the `service_role` line and revoke that key.

Then set the printer's IP in the admin console (Phase 4), and install the systemd
service for auto-start (see `install.sh` output).

## Preview a badge without a printer

```bash
./venv/bin/python badge.py "Sarah Goldberg" sample-badge.png
```

Badge appearance (header / subtitle / sizes / dimensions) is driven by the
`badge_template` JSON in `printer_config`, editable from the admin console.


## Configuring a new printer

`printer_config.py` drives a QL-820NWB's web UI over Ethernet to get it ready
for kiosk use: clock, panel language, power behaviour, and joining the WiFi
network. Every field name comes from
[docs/PRINTER_RECON_QL820NWB.md](../docs/PRINTER_RECON_QL820NWB.md), captured
from a factory-reset unit on **firmware 1.32** — a different firmware is
reported and warned about rather than silently assumed to match.

```bash
# dry run: everything except WiFi, so the wired link stays up
PRINTER_WEB_PASSWORD=xxxx ./venv/bin/python printer_config.py 192.168.1.27

# the real thing, WiFi last
PRINTER_WEB_PASSWORD=xxxx PRINTER_WIFI_PASSPHRASE=yyyy \
  ./venv/bin/python printer_config.py 192.168.1.27 --ssid "Lobby-WiFi"
```

The web-UI password is the code printed on the back of the printer, and is read
from the environment so it stays out of shell history and process lists.

It prints a redacted transcript of everything it attempted — safe to paste into
a ticket — and neither the WiFi passphrase nor the printer password appears in
it.

### Things worth knowing

- **Command mode is deliberately not touched.** brother_ql puts a dynamic
  switch (`ESC i a 01`) in every job, so the printer rasterises whatever its
  stored mode says. Verified on hardware: a badge printed while the panel still
  showed form mode.
- **WiFi is applied last and the wired link drops as it applies.** That is
  expected and reported as success. The printer then takes a **different IP**
  (the two interfaces have separate MACs), so it has to be rediscovered.
- **Wait ~90 seconds** after any reboot before expecting the printer to answer.
- **Auto power on does not work while Ethernet is connected.** It applies once
  the printer is on WiFi with the cable removed, so the configuration reboot
  itself has to be a button press.
- **This model does not answer status queries**, so media type and width show
  as unknown in the admin. Printing is unaffected.


## Finding a printer after the WiFi cutover

The printer's wired and wireless interfaces have **different MAC addresses**,
so they take different DHCP leases: the moment it moves to WiFi its address
changes and the old one is dead. `discover.py` finds it again.

```bash
./venv/bin/python discover.py                              # every Brother printer here
./venv/bin/python discover.py --mac 44:f7:9f:bc:ab:e8      # one specific printer
```

The wireless MAC is printed by `printer_config.py` during configuration, which
is the only time it can be read — afterwards the printer is no longer at the
address you were talking to.

Three routes, cheapest first, none needing an extra dependency:

1. **mDNS.** Brother answers to `BRW<mac>.local` (wireless) or `BRN<mac>.local`
   (wired), which the Pi resolves through avahi.
2. **A subnet sweep** of port 9100, for networks that block multicast.
3. **Identification** of what turns up: the ARP table gives each candidate's
   MAC — exact — and the printer's status page is readable *without logging
   in*, which gives the model as a fallback.

Two things learned from real hardware, both of which would otherwise have
caused a puzzling field failure:

- **mDNS also advertises a link-local `169.254.x.x` address** (and IPv6).
  Taking the first answer sends the bridge somewhere unroutable, so answers are
  ranked with our own subnet first and link-local last.
- **mDNS answers are cached, so a printer that is switched off still resolves.**
  Resolution is treated as a hint and every candidate is checked for an open
  print port before being accepted.
