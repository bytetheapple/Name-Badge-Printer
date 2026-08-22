# Phase A2 — how to apply

Roles, the org switcher, and member management. One migration, one Edge
Function, one app deploy. As in A1, the SQL is pasted by hand into the Supabase
web editor — do **not** run `supabase db push`.

| # | What | Where |
|---|---|---|
| 1 | `supabase/migrations/20260821200000_mt_a2_roles.sql` | Supabase SQL editor |
| 2 | `supabase functions deploy invite-member` | terminal |
| 3 | App deploy (the branch's front-end changes) | Vercel |
| ✔ | `supabase/tests/roles_test.sql`, then `supabase/tests/isolation_test.sql` | Supabase SQL editor |

Rehearsed end to end offline first — `cd supabase/tests && npm run dryrun`.

## 1. The migration

Additive and idempotent; it changes **write** policies only, so reads are
unaffected while it runs. Everyone currently in the system was backfilled as
`owner` in A1, so nobody loses access the moment it lands.

Remember that the SQL editor shows result sets only and discards `raise notice`
output — success here is "no red error".

## 2. The Edge Function

```bash
supabase functions deploy invite-member
```

Optionally point invited users at the app's set-password page (otherwise the
project's configured Site URL is used):

```bash
supabase secrets set INVITE_REDIRECT_URL=https://name-badge-printer.vercel.app/admin/set-password
```

**Invitations depend on the project's SMTP settings.** Supabase's built-in mail
sender is rate-limited and, on newer projects, only delivers to members of the
Supabase org — so if invites do not arrive, configure a real SMTP provider in
Authentication → Emails. The function reports the underlying failure rather than
silently swallowing it.

## 3. Verify

Run `supabase/tests/roles_test.sql` — 19 checks, all `pass`, ending
`ALL CHECKS PASSED`. Then re-run `supabase/tests/isolation_test.sql`; A2 rewrote
policies, so the isolation guarantee is worth re-confirming.

In the app:

1. Sign in as yourself. The header shows the org name, your role, and — because
   you are a platform admin in more than one org only once a second org exists —
   the switcher appears when you belong to more than one.
2. Members → invite an address you control as **staff**. Sign in as them and
   confirm: no Printer, Settings or Members tabs, but Entries, Status and QR
   work, and reprint/test-print still work.
3. As the staff user, browse to `/admin/settings` directly. The screen refuses,
   and so would the database.

## What changed for the design

MULTI_TENANT_DESIGN.md §5 describes inviting as "insert a pending `membership`
for an email". That is not possible as written: `memberships.user_id` is a
foreign key to `auth.users`, so there is no row to point at before the person
has an account. Since sign-ups are disabled on this project, the invite instead
**creates the account and the membership immediately** via the Auth admin API,
and the invitee sets a password through the existing `/admin/set-password`
route. Same outcome, no pending state to reconcile.

## Not in A2

Bridge tokens (A3), kiosk tokens and rate limiting (A4), Vault (A5),
provisioning tooling and the super-admin console (A6). The print bridge and the
public sign-in path are untouched by this phase.
