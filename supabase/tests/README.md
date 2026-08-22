# Database tests

## `isolation_test.sql`

The tenant-isolation suite from [MULTI_TENANT_DESIGN.md](../../MULTI_TENANT_DESIGN.md)
§15. Paste it into the **Supabase SQL editor** and run it; the last notice must
read `TENANT ISOLATION: ALL CHECKS PASSED`. It runs inside `BEGIN … ROLLBACK`,
so it writes nothing — safe against production.

## `dryrun.mjs`

Applies every migration, in order, to a throwaway in-process Postgres
([PGlite](https://pglite.dev)) shaped like a Supabase project — the `anon` /
`authenticated` / `service_role` roles, an `auth.users` table, `auth.uid()`.
Nothing touches the real database, and no Docker is required.

```bash
cd supabase/tests && npm install && npm run dryrun
```

It checks that:

- all migrations apply cleanly to a copy of the production schema, and are
  idempotent (safe to paste twice);
- the writers that exist today — the `service_role` Edge Functions and the admin
  portal — keep working without sending `org_id`, and every row still lands
  stamped;
- a signed-in admin still reads all of their own org's data through the new
  policies;
- `isolation_test.sql` passes, and leaves no rows behind;
- **negative control:** the same test *fails* against a deliberately leaky
  policy. Without this, "the isolation test passed" would prove nothing;
- the A4 failsafe holds: once a second org exists, an insert with no `org_id` is
  refused instead of being filed under the wrong tenant.

Re-run it after any migration or policy change.
