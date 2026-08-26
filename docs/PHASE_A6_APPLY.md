# Phase A6 — the platform console

The last phase of Track A. Everything here was a hand-written SQL statement:
creating a tenant, issuing a print server's credential, granting custom
integrations, suspending a customer.

## Apply

1. **Migration** — `supabase/migrations/20260827120000_mt_a6_platform.sql`

   The last statement returns three rows. `org_is_active` must **not** list
   `anon` or `authenticated`: it takes an org id and decides whether to serve
   someone.

2. **Edge Functions** — the suspension check touches the kiosk and bridge paths:

       supabase functions deploy submit-badge public-config job-status upload-selfie bridge-poll

3. **The Pi** — `git pull && sudo systemctl restart badge-bridge`

4. **The app.** A **Platform** item appears in the nav, for platform admins only.

## Verify

`isolation_test.sql` (59 checks) and `roles_test.sql` (34) both end with
ALL CHECKS PASSED. The A6 ones worth watching:

* `create_organization: makes a tenant` / `the creator owns it` / `settings rows exist`
* `org_is_active: follows status, and is reversible`
* `platform_overview: empty for a tenant`
* `owner: cannot change the organization status`

## Creating a tenant

Platform → Create an organization. Name and slug; the slug is lowercase letters,
numbers and hyphens, and appears in support conversations.

**You become its owner.** That is deliberate — it lets you set up printers and
integrations before the customer ever signs in — but it means your account stays
attached until you hand over. Orgs in that state are marked **not handed over**
in the list, so it is visible rather than remembered.

Handing over: switch into the org, Members → invite the real owner, then remove
yourself. The last-owner guard from A2 stops you leaving an org with no owner,
so promote them first.

Creating an org also creates the three per-org singleton rows
(`printer_config`, `printer_status`, `app_settings`). Their absence does not
fail loudly — it surfaces later as a kiosk with no settings — which is why the
function does it rather than a checklist.

## Suspension now has teeth

`organizations.status` existed since A1 and nothing read it. It does now:

* **Kiosks stop accepting sign-ins**, with a message that does not mention
  billing — it is a screen in a lobby and it is not the visitor's problem.
* **The print server stops receiving jobs.** Its credential stays valid; this
  is not a revocation, and reporting one would send an operator hunting the
  wrong fault. The bridge logs the reason once per spell rather than every
  poll.

Nothing is deleted and resuming restores service within seconds.

A tenant cannot lift its own suspension. A2's update policy on `organizations`
is column-blind — an owner can rename the org — so the guard is a trigger, and
the harness removes it to prove the test catches an owner reactivating
themselves.

The check fails **open** on a transport error: a database hiccup must not read
as a suspension and stop a lobby working. Only the function returning false
suspends anyone.

## Still not in A6

Deleting an organization, transferring ownership between users in one step,
and any billing hook. `plan` remains an unused column.
