# Phase A3 — how to apply

Retires the project-wide `service_role` key from the Raspberry Pi and replaces
it with a per-device token scoped to one organization.

The order matters: **nothing on the Pi changes until you choose to change it.**
Steps 1–3 are additive and invisible to the running bridge, which keeps printing
on `service_role` throughout. Step 4 is the cutover, and it is reversible.

| # | What | Where |
|---|---|---|
| 1 | `supabase/migrations/20260821210000_mt_a3_bridge_tokens.sql` | Supabase SQL editor |
| 2 | `supabase functions deploy bridge-poll bridge-complete` | terminal |
| 3 | App deploy (adds **Printer → Print servers**) | Vercel |
| 4 | Cut the Pi over | on the Pi |
| ✔ | `roles_test.sql` and `isolation_test.sql` | Supabase SQL editor |

Rehearsed offline first: `cd supabase/tests && npm run dryrun`, and
`cd bridge && ./venv/bin/python test_client.py`.

## 4. Cutting the Pi over

Issue a token in the admin (**Printer → Print servers**) — it is shown once —
then, on the Pi:

```bash
cd ~/name-badge-printer && git pull
cd bridge && ./venv/bin/python test_client.py
nano .env          # add BRIDGE_TOKEN=…, comment out SUPABASE_SERVICE_ROLE_KEY
sudo systemctl restart name-badge-bridge
journalctl -u name-badge-bridge -n 20
```

The start-up line tells you which credential is in use:

```
bridge starting; auth: bridge token; polling every 2.0s
```

If it still says `auth: service_role (deprecated)` the token was not picked up —
the bridge also logs a warning in that case. Both credentials may be present at
once and the token always wins, so **rolling back is just commenting out
`BRIDGE_TOKEN` and restarting**.

Then print a test badge from the admin Status panel and confirm it comes out.

## 5. Afterwards

Once the Pi has run on its token for a day or so:

1. Delete the `SUPABASE_SERVICE_ROLE_KEY` line from `bridge/.env`.
2. **Rotate the `service_role` key** in the Supabase dashboard — it has been
   sitting on a device and should be treated as exposed. Redeploy the Edge
   Functions afterwards so they pick up the new key.

Until step 2 the old key still works from anywhere; A3 is not finished without
it.

## What A3 does not change

`print_jobs` still carries the queue and the admin still queues reprints the
same way. The public sign-in path, the external print API, and badge rendering
are untouched. Kiosk tokens and rate limiting are A4.
