// Dry-run the Name Badge Printer migrations against an in-process Postgres
// (PGlite) with a minimal Supabase-shaped stub.
//
//   base migrations -> seed "live" single-tenant data -> A1 migrations
//   -> re-run the writers that exist today -> admin portal read -> isolation test
//
// Also runs a NEGATIVE CONTROL: the same isolation test against a deliberately
// leaky policy, which must fail. Otherwise "the test passed" proves nothing.
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MIG = path.join(REPO, 'supabase/migrations')
const ADMIN = '22222222-2222-4222-8222-222222222222'

const all = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()
// Everything up to the multi-tenant work is the schema as it was in production
// before the refactor; the `_mt_a*` files are the phased refactor itself.
const mt = all.filter((f) => f.includes('_mt_a'))
const base = all.filter((f) => !f.includes('_mt_a'))
const read = (f) => readFileSync(path.join(MIG, f), 'utf8')

const STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;   -- as on Supabase
grant usage on schema public to anon, authenticated, service_role;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid
language sql stable as $fn$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$fn$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;

create publication supabase_realtime;

-- Supabase enables RLS on tables newly created in the public schema.
-- Reproduce that, so a helper table that forgets to account for it fails here
-- rather than in the SQL editor.
create or replace function public._rls_on_new_tables() returns event_trigger
language plpgsql as $fn$
declare obj record;
begin
  for obj in select * from pg_event_trigger_ddl_commands() loop
    if obj.command_tag = 'CREATE TABLE' and obj.schema_name = 'public' then
      execute format('alter table %s enable row level security', obj.object_identity);
      -- …and exposes it to the Data API roles. Modelling this is what makes a
      -- migration's own REVOKE meaningful here instead of being papered over.
      execute format(
        'grant select, insert, update, delete on %s to anon, authenticated, service_role',
        obj.object_identity);
    end if;
  end loop;
end
$fn$;
create event trigger rls_on_new_tables on ddl_command_end
  when tag in ('CREATE TABLE') execute function public._rls_on_new_tables();
`

// Tables are granted at creation by the event trigger above, exactly as the
// real project does it. Sequences still need a blanket grant.
const GRANTS = `
grant usage, select on all sequences in schema public
  to anon, authenticated, service_role;
`

const SEED = `
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'shelbert@me.com'),
  ('${ADMIN}', 'office@shirhadash.example');

update public.printers set printer_ip = '192.168.1.50' where name = 'Main Printer';
insert into public.form_entries (first_name, last_name, visitor_type, printer_id)
select 'Existing', 'Visitor', 'visitor', id from public.printers limit 1;
insert into public.print_jobs (entry_id, printer_id, type, status)
select e.id, e.printer_id, 'badge', 'printed' from public.form_entries e;
`

let failed = false
const ok = (m) => console.log(`  ok    ${m}`)
const bad = (m, e) => {
  failed = true
  console.log(`  FAIL  ${m}${e ? '\n        ' + String(e.message).split('\n')[0] : ''}`)
}

// Build a database up to (and including) the A1 migrations.
// `sabotage` optionally rewrites the RLS migration to prove the test bites.
async function build(sabotage) {
  const db = await new PGlite()
  await db.exec(STUB)
  for (const f of base) { await db.exec(read(f)); await db.exec(GRANTS) }
  await db.exec(SEED)
  for (const f of mt) {
    let sql = read(f)
    if (sabotage) sql = sabotage(sql, f)
    await db.exec(sql)
    await db.exec(GRANTS)
  }
  return db
}

// Run SQL as a signed-in admin (what the browser client does).
const asUser = (uid, sql) => `
  set request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}';
  set role authenticated;
  ${sql}
  reset role;
  set request.jwt.claims = '';
`

console.log('— migrations apply to a copy of the production schema —')
let db
try { db = await build(); ok(`all ${all.length} migrations applied in order`) }
catch (e) { bad('migrations', e); process.exit(1) }

const q = async (sql) => (await db.query(sql)).rows[0]
console.log(' ', JSON.stringify(await q(`
  select (select count(*) from public.organizations)   as orgs,
         (select count(*) from public.memberships)     as memberships,
         (select count(*) from public.platform_admins) as platform_admins,
         (select slug from public.organizations limit 1) as slug`)))

console.log('— the writers that exist today keep working, unchanged —')
// submit-badge / print-badge run with the service_role key and send no org_id.
try {
  await db.exec(`
    set role service_role;
    insert into public.form_entries (first_name, last_name, visitor_type, printer_id, google_sync_status, shulcloud_sync_status)
    select 'New', 'Signin', 'visitor', id, 'pending', 'pending' from public.printers limit 1;
    insert into public.print_jobs (entry_id, printer_id, type, status)
    select id, printer_id, 'badge', 'queued' from public.form_entries where first_name = 'New';
    insert into public.print_jobs (printer_id, type, status, first_name)
    select id, 'badge', 'queued', 'ApiCaller' from public.printers limit 1;
    reset role;`)
  ok('public sign-in + print API inserts (service_role, no org_id sent)')
} catch (e) { bad('service_role inserts', e) }

try {
  await db.exec(asUser(ADMIN, `
    insert into public.printers (name, port) values ('Second Printer', 9100);
    insert into public.print_jobs (type, status, printer_id)
    select 'test', 'queued', id from public.printers where name = 'Second Printer';
    update public.printer_config set label_media = '62' where id = 1;
    update public.app_settings set selfie_mode = 'optional' where id = 1;`))
  ok('admin portal writes (authenticated, no org_id sent)')
} catch (e) { bad('admin portal writes', e) }

const stamp = await q(`
  select count(*) filter (where org_id is null) as unstamped, count(*) as total from (
    select org_id from public.form_entries
    union all select org_id from public.print_jobs
    union all select org_id from public.printers
    union all select org_id from public.printer_config
    union all select org_id from public.printer_status
    union all select org_id from public.app_settings) t`)
if (Number(stamp.unstamped) === 0 && Number(stamp.total) === 11) ok(`every row stamped (${stamp.total} rows, 0 unstamped)`)
else bad(`row stamping: ${JSON.stringify(stamp)} (expected 11 rows, 0 unstamped)`)

console.log('— the admin portal still sees its own data through RLS —')
await db.exec(`set request.jwt.claims = '{"sub":"${ADMIN}","role":"authenticated"}'; set role authenticated;`)
const portal = await q(`
  select (select count(*) from public.form_entries)   as entries,
         (select count(*) from public.print_jobs)     as jobs,
         (select count(*) from public.printers)       as printers,
         (select count(*) from public.printer_config) as config,
         (select count(*) from public.printer_status) as status,
         (select count(*) from public.app_settings)   as settings`)
await db.exec(`reset role; set request.jwt.claims = '';`)
const expected = { entries: 2, jobs: 4, printers: 2, config: 1, status: 1, settings: 1 }
const got = Object.fromEntries(Object.entries(portal).map(([k, v]) => [k, Number(v)]))
if (JSON.stringify(got) === JSON.stringify(expected)) ok(`admin sees all of its org: ${JSON.stringify(portal)}`)
else bad(`admin portal read: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)

console.log('— isolation test —')
const TEST = readFileSync(path.join(REPO, 'supabase/tests/isolation_test.sql'), 'utf8')
try {
  // The SQL editor renders the last result-producing statement, so the test's
  // visible output is its results table. Check it is actually produced.
  const res = await db.exec(TEST)
  const table = res.filter((r) => r.rows?.length).pop()
  const rows = table?.rows ?? []
  const failures = rows.filter((r) => r.result !== 'pass')
  if (!rows.length) bad('isolation_test.sql produced no result table — the editor would show "No rows returned"')
  else if (failures.length) bad(`isolation_test.sql reported ${failures.length} non-pass row(s)`)
  else if (rows.at(-1).check_name !== 'ALL CHECKS PASSED') bad(`isolation_test.sql did not end with ALL CHECKS PASSED (last row: ${rows.at(-1).check_name})`)
  else ok(`isolation_test.sql passed, ${rows.length} checks reported in its result table`)
} catch (e) {
  bad('isolation_test.sql', e)
  await db.exec('rollback').catch(() => {})  // the failure aborted the transaction
}

// The test rolls itself back, so the database must be untouched afterwards.
const after = await q(`select count(*) as orgs from public.organizations`)
if (Number(after.orgs) === 1) ok('isolation test left no rows behind (rolled back)')
else bad(`isolation test leaked rows: ${JSON.stringify(after)}`)

console.log('— role matrix test (A2) —')
const ROLES = readFileSync(path.join(REPO, 'supabase/tests/roles_test.sql'), 'utf8')
try {
  const res = await db.exec(ROLES)
  const rows = res.filter((r) => r.rows?.length).pop()?.rows ?? []
  if (!rows.length) bad('roles_test.sql produced no result table')
  else if (rows.some((r) => r.result !== 'pass')) bad('roles_test.sql reported a non-pass row')
  else if (rows.at(-1).check_name !== 'ALL CHECKS PASSED') bad('roles_test.sql did not end with ALL CHECKS PASSED')
  else ok(`roles_test.sql passed, ${rows.length} checks reported in its result table`)
} catch (e) {
  bad('roles_test.sql', e)
  await db.exec('rollback').catch(() => {})
}

console.log('— negative control: a leaky policy must FAIL the test —')
const leaky = await build((sql, f) =>
  f.includes('_rls')
    ? sql.replace(
        `create policy "org read form_entries" on public.form_entries\n  for select to authenticated\n  using (org_id in (select public.auth_org_ids()));`,
        `create policy "org read form_entries" on public.form_entries\n  for select to authenticated\n  using (true);`)
    : sql)
try {
  await leaky.exec(TEST)
  bad('negative control: the test PASSED against a leaky form_entries policy — it is not actually checking')
} catch (e) {
  const msg = String(e.message).split('\n')[0]
  if (msg.includes('ISOLATION FAILURE') && msg.includes('form_entries')) ok(`negative control caught the leak: "${msg}"`)
  else bad(`negative control failed for the wrong reason: ${msg}`)
}

console.log('— negative control: a role-blind policy must FAIL the role test —')
const roleBlind = await build((sql, f) =>
  f.includes('_mt_a2_')
    ? sql.replace(
        'with check (public.auth_is_org_admin(org_id));\n\ndrop policy if exists "org update printers"',
        'with check (org_id in (select public.auth_org_ids()));\n\ndrop policy if exists "org update printers"')
    : sql)
try {
  await roleBlind.exec(ROLES)
  bad('negative control: the role test PASSED with staff able to add printers — it is not actually checking')
} catch (e) {
  const msg = String(e.message).split('\n')[0]
  if (msg.includes('ROLE FAILURE') && msg.includes('printer')) ok(`negative control caught it: "${msg}"`)
  else bad(`role negative control failed for the wrong reason: ${msg}`)
}

console.log('— the migrations are idempotent (safe to paste twice) —')
try { for (const f of mt) await db.exec(read(f)); ok(`re-applying all ${mt.length} multi-tenant migrations is a no-op`) }
catch (e) { bad('re-applying the multi-tenant migrations', e) }

console.log('— failsafe: once a second org exists, an unstamped insert must fail —')
await db.exec(`insert into public.organizations (slug, name) values ('second-tenant', 'Second Tenant');`)
try {
  await db.exec(`
    set role service_role;
    insert into public.form_entries (first_name, visitor_type) values ('Unstamped', 'visitor');
    reset role;`)
  bad('a second org exists and an org_id-less insert still succeeded — it could land in the wrong tenant')
} catch (e) {
  await db.exec('reset role')
  const msg = String(e.message).split('\n')[0]
  if (/null value in column "org_id"|violates not-null/i.test(msg)) ok(`refused loudly: "${msg}"`)
  else bad(`refused, but for the wrong reason: ${msg}`)
}

console.log(failed ? '\nRESULT: FAILURES' : '\nRESULT: all checks passed')
process.exit(failed ? 1 : 0)
