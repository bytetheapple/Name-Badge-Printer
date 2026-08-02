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
- **Auth** — uses the Supabase `service_role` key (bypasses RLS). Keep it secret;
  it lives only in `bridge/.env` on the Pi.

## Files

| File | Purpose |
|------|---------|
| `bridge.py` | Main loop: poll, claim, print, heartbeat |
| `db.py` | Tiny PostgREST client (Supabase Data API) |
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
cp .env.example .env      # then fill in SUPABASE_SERVICE_ROLE_KEY
./venv/bin/python bridge.py   # test run
```

Then set the printer's IP in the admin console (Phase 4), and install the systemd
service for auto-start (see `install.sh` output).

## Preview a badge without a printer

```bash
./venv/bin/python badge.py "Sarah Goldberg" sample-badge.png
```

Badge appearance (header / subtitle / sizes / dimensions) is driven by the
`badge_template` JSON in `printer_config`, editable from the admin console.
