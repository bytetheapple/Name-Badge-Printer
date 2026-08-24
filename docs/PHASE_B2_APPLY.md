# Phase B2 — how to apply

"Scan and add printer": the admin asks, the bridge looks, and what it finds
becomes a printer with one click.

**Why it works this way.** Printers live on the customer's LAN. Neither the
Edge Functions (in Supabase's cloud) nor the admin app (an HTTPS page, and
blocked by the absence of CORS on the printer) can reach them. The bridge is
the only thing that can, so discovery rides on the same `bridge-poll` channel
that already carries print jobs.

| # | What | Where |
|---|---|---|
| 1 | `supabase/migrations/20260823160000_mt_b2_discovered_printers.sql` | Supabase SQL editor |
| 2 | `supabase functions deploy bridge-poll` | terminal |
| 3 | App deploy — Printer gains **Find a printer** | Vercel |
| 4 | Update the Pi: `git pull` and restart the bridge | on the Pi |
| ✔ | `isolation_test.sql`, `roles_test.sql` | Supabase SQL editor |

Rehearsed offline: `cd supabase/tests && npm run dryrun`, and the bridge suites
under `bridge/`.

## How a scan flows

1. An admin presses **Scan for printers**. That writes
   `printer_status.scan_requested_at` — nothing else happens yet.
2. The bridge's next poll (within a couple of seconds) comes back with
   `scan: true`, and the request is cleared as it is handed over, so one ask
   produces one scan even with several bridges on the org.
3. The bridge sweeps its own network — mDNS first, then port 9100 — and reports
   what it found on its *next* poll.
4. `discovered_printers` is upserted per `(org_id, ip)`, so an address that
   keeps turning up updates rather than accumulating, and keeps its
   `first_seen`.
5. The admin sees the list and adds one, which creates a normal `printers` row
   and drops it from the scan cache.

A request older than five minutes is ignored, so a bridge that was offline does
not start sweeping the moment it reconnects.

## What this does not do

It does not configure a printer it finds — that is `provision.py`, which still
needs someone at the printer to work the panel through a factory reset and a
power cycle. Scan-and-add is for a printer that is **already on the network**:
newly provisioned, or moved, or one whose address changed.

## Ordering note

The bridge changes and the Edge Function change go together: `bridge-poll`
returns a new `scan` field and accepts `discovered`, and the bridge's `poll()`
now returns a `Poll` object rather than a tuple. An old bridge against the new
function is harmless — it ignores `scan` and never reports — but a new bridge
against the old function will simply never be asked to scan. Deploy the
function before updating the Pi.
