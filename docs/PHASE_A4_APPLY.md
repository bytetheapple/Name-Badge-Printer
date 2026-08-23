# Phase A4 — how to apply

Kiosk tokens, rate limiting, per-org API keys, and retiring the transitional
`org_id` trigger.

**The order matters more than in previous phases.** Steps 1–3 are additive and
leave every existing link working. Step 4 is the one that can break the public
sign-in path if anything was missed, so it is deliberately last and separate.

| # | What | Where |
|---|---|---|
| 1 | `supabase/migrations/20260822120000_mt_a4_kiosk_tokens.sql` | Supabase SQL editor |
| 2 | `supabase functions deploy` (public-config, submit-badge, job-status, upload-selfie, print-badge changed) | terminal |
| 3 | App deploy — `/k/<token>` route, QR rotation, API keys screen | Vercel |
| ✔ | **Verify a real sign-in works** | phone in a lobby |
| 4 | `supabase/migrations/20260822130000_mt_a4_drop_org_id_trigger.sql` | Supabase SQL editor |
| ✔ | `roles_test.sql`, `isolation_test.sql` | Supabase SQL editor |

Rehearsed offline: `cd supabase/tests && npm run dryrun`.

## Nothing already printed stops working

Existing QR codes encode `…/?printer=<uuid>`. That route still resolves — the
org is read off the printer row, exactly as it is for a kiosk token, so it was
never the part that needed replacing. What kiosk tokens add is **rotation**: a
printer's uuid cannot be changed if a code is abused, but a token can.

New printers get a token automatically. Reprint existing codes whenever
convenient — ideally once the product domain is settled, so it is one trip.

## Between steps 3 and 4 — verify before you cut the rope

Step 4 removes the safety net that lets an unstamped insert succeed. Before
applying it, confirm the new writers are stamping correctly:

1. Scan a lobby QR code (the old `?printer=` one) → the form loads → sign in →
   a badge prints. This is the legacy path.
2. Admin → QR Code → the code now shows a `/k/…` URL. Scan it from a phone and
   sign in. This is the new path.
3. Admin → Entries → both sign-ins are listed.

If either fails, **do not apply step 4** — the trigger is what is keeping the
old path alive, and removing it would turn a broken write into a failed
sign-in.

## Step 4 is reversible

If inserts start failing afterwards, some writer was missed. The migration file
carries the SQL to put the trigger back; re-adding it restores the previous
behaviour immediately.

## What this unblocks

`default_org_id()` was the last place the system would guess which tenant a row
belonged to, and it deliberately refused to guess once a second org existed —
which is what has been blocking a second congregation. With step 4 applied,
**onboarding tenant #2 is no longer gated on anything in Track A.**

## Rate limits

Defaults, all in `check_submit_allowed()`:

| Limit | Default |
|---|---|
| Sign-ins per IP per minute | 6 |
| Sign-ins per printer per minute | 30 |
| Badges queued or printing at one printer | 40 |

A visitor who trips one sees a plain message asking them to wait; the limiter
**fails open** on an infrastructure error, because a broken limiter must never
stop a congregation signing people in. Change a default by editing the
function's argument defaults.

## Print API keys

`Settings → Print API keys` issues per-org keys for the external API. The old
project-wide `PRINT_API_KEY` still works while Shir Hadash is the only
organization, and stops working the moment a second exists — so issue a real key
and update any caller before onboarding anyone else.

## Not in A4

Per-tenant integration secrets and Vault (A5); provisioning tooling and the
super-admin console (A6). Google/ShulCloud sync still uses the project-wide
service account.
