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
