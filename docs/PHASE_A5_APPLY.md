# Phase A5 — how to apply

Per-organization integration settings, with real credentials in Supabase Vault.

**Why this phase matters more than it looks.** RLS has protected the database
since A1, but Google Forms, ShulCloud and the Drive service account were still
configured with project-wide environment variables. A second congregation's
visitors would have been posted into *Shir Hadash's* Google Form — a leak that
happens entirely outside the database, where no policy can reach it. A4 made a
second tenant technically possible; A5 is what makes one safe.

| # | What | Where |
|---|---|---|
| 1 | `supabase/migrations/20260823120000_mt_a5_integrations.sql` | Supabase SQL editor |
| 2 | `supabase functions deploy` (google-sync, shulcloud-sync, upload-selfie changed) | terminal |
| 3 | App deploy — Settings gains an Integrations section | Vercel |
| ✔ | `roles_test.sql`, `isolation_test.sql` | Supabase SQL editor |

Rehearsed offline: `cd supabase/tests && npm run dryrun`.

**Vault must be enabled.** It normally already is on a Supabase project. The
migration installs it if it is merely available and stops with a clear message
if it is not, rather than failing later at the first attempt to save a key.

## Nothing changes for Shir Hadash until you choose

An org with no integration configured keeps using the existing environment
variables. That fallback is withdrawn the moment a second organization exists —
at which point the sync reports "not configured for this organization" and
leaves the entry `pending`, which is the state the admin's resync button already
handles. So:

**Before onboarding a second congregation, move Shir Hadash's settings into
Settings → Integrations.** Otherwise its syncs stop the day the second org is
created. The values to copy are the ones currently in `supabase secrets list`:

| Environment variable | Integration | Field |
|---|---|---|
| `GOOGLE_FORM_RESPONSE_URL` | Google Form | Form response URL |
| `GOOGLE_ENTRY_FIRST_NAME` | Google Form | First name field |
| `GOOGLE_ENTRY_LAST_NAME` | Google Form | Last name field |
| `GOOGLE_ENTRY_PHONE` | Google Form | Phone field |
| `GOOGLE_COLLECT_EMAIL` | Google Form | Built-in email capture |
| `GOOGLE_EXTRA_FIELDS` | Google Form | Fixed answers |
| `SHULCLOUD_FORM_URL` | ShulCloud | Form URL |
| `SHULCLOUD_FIELD_*` | ShulCloud | the matching inputs |
| `SHULCLOUD_SUCCESS_TEXT` | ShulCloud | Success text |
| `GOOGLE_SA_CLIENT_EMAIL` | Google Drive | Service account email |
| `GOOGLE_SA_PRIVATE_KEY` | Google Drive | Service account private key |

Tick **"Use this organization's own settings"** on each, save, then sign in as a
test visitor and confirm the entry reaches Google and ShulCloud.

> **Done, and the fallback is gone.** Shir Hadash was moved onto its own
> configuration on 26 August 2026 and the fourteen environment variables were
> removed. The fallback code went with them — `resolveSettings()` now reads
> only the org's own row, and an org that has not configured an integration
> syncs nowhere rather than inheriting anyone's. The table above is kept
> because it is still the map from an old deployment's variables to the fields
> that replaced them.

## Credentials are write-only

The Drive private key goes into Vault through a database function. Nothing reads
it back to a browser — not the API, not the admin who saved it. The screen shows
only whether a key is stored. If one is lost, replace it; there is no recovery,
by design.

## Three bugs this phase fixed

Found by the tests, all pre-existing:

1. **`auth_is_org_admin()` returned NULL, not false, for a non-member.** RLS
   reads NULL as deny, so A2–A4 were never at risk — but a PL/pgSQL guard
   written `if not auth_is_org_admin(...)` skips its branch on NULL, and this
   phase needed exactly such a guard. The helpers are now total.
2. **An organization could never be deleted.** The delete cascaded into
   memberships and tripped A2's last-owner guard. It now stands down when the
   org itself is going away — which offboarding a tenant needs.
3. **Vault rows outlived their integration rows**, leaving a removed tenant's
   credentials in the vault indefinitely.

## Not in A5

Provisioning tooling and the super-admin console (A6). Creating an organization
is still a manual SQL step.
