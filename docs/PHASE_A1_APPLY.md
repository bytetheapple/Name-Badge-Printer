# Phase A1 — how to apply

Three migrations plus an isolation test. Paste each into the **Supabase SQL
editor in this order**, checking the result before moving on. Nothing here is
destructive to existing data: columns are added nullable, backfilled, then
constrained (per [DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md) principles).

| # | File | What it does | Live impact |
|---|---|---|---|
| 1 | `supabase/migrations/20260821190000_mt_a1_foundations.sql` | New tables (`organizations`, `memberships`, `platform_admins`), helper functions, nullable `org_id` on the six tenant tables, singletons become per-org | None — no policy changes, no NOT NULL |
| 2 | `supabase/migrations/20260821190100_mt_a1_backfill.sql` | Creates **Shir Hadash** as org #1, stamps every existing row, gives every current auth user an `owner` membership, then sets `org_id NOT NULL` | None visible; succeeds silently (see the note on notices below) |
| 3 | `supabase/migrations/20260821190200_mt_a1_rls.sql` | Replaces the "any authenticated user sees everything" policies with org-scoped ones | **This is the cutover.** After it, the admin portal only shows rows for orgs you are a member of |
| ✔ | `supabase/tests/isolation_test.sql` | Proves org A sees zero rows of org B on every table | None — runs inside `BEGIN … ROLLBACK` |

> These are applied by hand in the web SQL editor; do **not** run
> `supabase db push` (the local migration history is out of sync with the
> remote project).

All four have already been rehearsed end to end against a throwaway Postgres
that mirrors the production schema — see
[supabase/tests/README.md](../supabase/tests/README.md):

```bash
cd supabase/tests && npm install && npm run dryrun
```

## Before you paste #2

It contains one line that grants **cross-tenant operator access**:

```sql
insert into public.platform_admins (user_id)
select id from auth.users where email = 'shelbert@me.com'
```

Change the address or delete the statement if that is not what you want.

## After #3 — check the app

1. Reload the admin portal and confirm entries, printers, status and settings
   all still appear (they are all stamped to Shir Hadash).
2. Submit a test sign-in from the public form → an entry and a print job appear
   and the badge prints. This exercises the transitional `org_id` trigger.
3. Run `supabase/tests/isolation_test.sql`. It returns a table with one row
   per check, all `pass`, ending with `ALL CHECKS PASSED`.

## The SQL editor does not show `raise notice`

It renders **result sets only** and discards notice output, so a migration whose
last statement is a `grant` or a `create policy` reports `No rows returned` —
which is what success looks like. A failure is a red error, never a silent one.

Because of that, `isolation_test.sql` collects its checks in a table and selects
it at the end rather than announcing them. The migrations themselves were
applied as-is and are deliberately left unchanged; run these read-only queries
if you want positive confirmation of what landed.

**After #1** — expect `3, 6, 4, 0`:

```sql
select
  (select count(*) from information_schema.tables
    where table_schema = 'public'
      and table_name in ('organizations', 'memberships', 'platform_admins'))  as new_tables,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and column_name = 'org_id'
      and table_name in ('form_entries', 'print_jobs', 'printers',
                         'printer_config', 'printer_status', 'app_settings'))  as org_id_columns,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('auth_org_ids', 'is_platform_admin',
                        'default_org_id', 'set_org_id_default'))               as helpers,
  (select count(*) from pg_constraint c join pg_class r on r.oid = c.conrelid
    where r.relname in ('printer_config', 'printer_status', 'app_settings')
      and c.contype = 'c' and pg_get_constraintdef(c.oid) ilike '%id = 1%')    as singleton_locks;
```

**After #2** — the backfill summary the notice would have shown:

```sql
select o.slug                                                          as org,
       (select count(*) from public.memberships  where org_id = o.id)  as members,
       (select count(*) from public.form_entries where org_id = o.id)  as entries,
       (select count(*) from public.print_jobs   where org_id = o.id)  as jobs,
       (select count(*) from public.printers     where org_id = o.id)  as printers,
       (select count(*) from public.platform_admins)                   as platform_admins
from public.organizations o
where o.slug = 'shir-hadash';
```

**After #3** — expect nine rows, every one with `rls_enabled = true`:

```sql
select c.relname        as table_name,
       c.relrowsecurity as rls_enabled,
       count(p.polname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public'
  and c.relname in ('form_entries', 'print_jobs', 'printers', 'printer_config',
                    'printer_status', 'app_settings', 'organizations',
                    'memberships', 'platform_admins')
group by c.relname, c.relrowsecurity
order by c.relname;
```

## What is transitional (removed in A4)

The public sign-in and print-API Edge Functions still run single-tenant on the
`service_role` key and do not send `org_id`. A BEFORE INSERT trigger
(`set_org_id_default`) fills it in — from the row's printer, else from
`default_org_id()`.

`default_org_id()` returns NULL as soon as the answer is ambiguous (a second org
exists, or the writer belongs to several orgs), so an unstamped insert fails
loudly instead of landing in the wrong tenant. **Consequence: a second
organization cannot be onboarded until A4 makes every writer derive `org_id`
from its own kiosk/API token.** That is deliberate.

## If something goes wrong

`org_id` and the new tables are additive and can stay. Only migration #3 changes
behaviour, so reverting means restoring the old permissive policies:

```sql
-- EMERGENCY REVERT of migration #3 only. Restores single-tenant behaviour
-- (every authenticated user sees every row). Re-apply #3 once fixed.
drop policy if exists "org read form_entries"    on public.form_entries;
drop policy if exists "org read print_jobs"      on public.print_jobs;
drop policy if exists "org insert print_jobs"    on public.print_jobs;
drop policy if exists "org read printers"        on public.printers;
drop policy if exists "org insert printers"      on public.printers;
drop policy if exists "org update printers"      on public.printers;
drop policy if exists "org delete printers"      on public.printers;
drop policy if exists "org read printer_config"  on public.printer_config;
drop policy if exists "org update printer_config" on public.printer_config;
drop policy if exists "org read printer_status"  on public.printer_status;
drop policy if exists "org read app_settings"    on public.app_settings;
drop policy if exists "org update app_settings"  on public.app_settings;

create policy "admins read form_entries"    on public.form_entries   for select to authenticated using (true);
create policy "admins read print_jobs"      on public.print_jobs     for select to authenticated using (true);
create policy "admins insert print_jobs"    on public.print_jobs     for insert to authenticated with check (type in ('badge','test'));
create policy "admins read printers"        on public.printers       for select to authenticated using (true);
create policy "admins insert printers"      on public.printers       for insert to authenticated with check (true);
create policy "admins update printers"      on public.printers       for update to authenticated using (true) with check (true);
create policy "admins delete printers"      on public.printers       for delete to authenticated using (true);
create policy "admins read printer_config"  on public.printer_config for select to authenticated using (true);
create policy "admins update printer_config" on public.printer_config for update to authenticated using (true) with check (true);
create policy "admins read printer_status"  on public.printer_status for select to authenticated using (true);
create policy "admins read app_settings"    on public.app_settings   for select to authenticated using (true);
create policy "admins update app_settings"  on public.app_settings   for update to authenticated using (true) with check (true);
```

## Not in A1

Roles/org switcher (A2), bridge tokens (A3), kiosk tokens and rate limiting
(A4), Vault (A5), provisioning tooling (A6). The Edge Functions and the print
bridge are **unchanged** by this phase.
