# Custom Integrations tab

Separates the two bespoke form syncs from the product's own settings, and puts
them behind a grant only the platform team can give.

## Why these two are different

Neither ShulCloud nor Google Form involves a credential. Both replicate a
browser submitting a public form — fetch it for a session cookie and CSRF
token, then POST. What they need is *configuration*: the form's address and the
names of its fields (`element_30776892`, `entry.123456`).

Getting those means reading a particular congregation's particular form, and
keeping up when it changes. That is work done by hand, per customer — which is
why it is sold rather than switched on.

Google Drive is not in this group. It uses a real service-account credential and
is part of the product for any org that wants selfies, so it stays in Settings.

## Apply

Paste into the Supabase SQL editor:

    supabase/migrations/20260824190000_mt_custom_integrations.sql

It adds `organizations.custom_integrations`, sets it for the `shir-hadash` org,
and installs the trigger that stops an org setting it for itself.

Then deploy the app. No Edge Function or bridge changes — the sync functions
already read per-org config and were not touched.

## Verify

`supabase/tests/roles_test.sql` should report 30 checks. Two are new and are
the point of the migration:

* `staff: cannot enable custom integrations`
* `owner: cannot enable custom integrations`

The second matters most. A2 gave owners `for update` on their own
`organizations` row so they could rename it, and RLS cannot say "every column
except this one" — so without the trigger an owner could grant themselves a
paid capability by writing one boolean. The dry-run harness removes the trigger
and confirms the test fails without it.

In the admin, **Custom Integrations** appears in the nav for admins. Shir
Hadash sees the Google Form and ShulCloud panels; any other org sees a short
paragraph pointing at support.

## Enabling it for a customer

There is no UI for this yet — it is a platform-admin action, and A6's
super-admin console is where it belongs. Until then, as service_role:

```sql
update public.organizations set custom_integrations = true where slug = '<slug>';
```

Running that as a signed-in org owner is refused, which is the intent.
