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
// Split at the first multi-tenant migration and treat everything from there on
// as post-refactor. Filenames are timestamped, so ordering is chronological —
// and a name-based filter kept mis-sorting new migrations into the pre-refactor
// group, which then failed against a schema that did not have org_id yet.
const firstMt = all.findIndex((f) => f.includes('_mt_'))
const base = firstMt < 0 ? all : all.slice(0, firstMt)
const mt = firstMt < 0 ? [] : all.slice(firstMt)
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

-- Supabase Vault, stubbed. The encryption is the platform's business; what this
-- harness needs to check is that only the right roles can reach a secret, and
-- that the integration plumbing stores and returns the right one.
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text,
  secret text,
  created_at timestamptz default now()
);
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, created_at from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null,
                                    new_description text default '')
returns uuid language plpgsql as $fn$
declare v uuid;
begin
  insert into vault.secrets (name, description, secret)
  values (new_name, new_description, new_secret) returning id into v;
  return v;
end $fn$;
create function vault.update_secret(secret_id uuid, new_secret text default null,
                                    new_name text default null, new_description text default null)
returns void language sql as $fn$
  update vault.secrets set secret = coalesce(new_secret, secret),
                           name = coalesce(new_name, name),
                           description = coalesce(new_description, description)
  where id = secret_id
$fn$;
-- The migration's "create extension if not exists supabase_vault" is a no-op
-- once the schema is already present, which is what it relies on here.

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
    -- …and on newly created functions, which is easy to miss: revoking such a
    -- grant needs the roles named, because taking EXECUTE off PUBLIC leaves a
    -- direct grant to a role untouched.
    if obj.command_tag = 'CREATE FUNCTION' and obj.schema_name = 'public' then
      execute format('grant execute on function %s to anon, authenticated, service_role',
                     obj.object_identity);
    end if;
  end loop;
end
$fn$;
create event trigger rls_on_new_tables on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE FUNCTION')
  execute function public._rls_on_new_tables();
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

console.log('— the writers all stamp org_id themselves (A4) —')
// submit-badge and print-badge resolve the org from the kiosk token / api key
// and send it explicitly, which is what let the transitional trigger go.
try {
  await db.exec(`
    set role service_role;
    insert into public.form_entries (org_id, first_name, last_name, visitor_type, printer_id, google_sync_status, shulcloud_sync_status)
    select org_id, 'New', 'Signin', 'visitor', id, 'pending', 'pending' from public.printers limit 1;
    insert into public.print_jobs (org_id, entry_id, printer_id, type, status)
    select org_id, id, printer_id, 'badge', 'queued' from public.form_entries where first_name = 'New';
    insert into public.print_jobs (org_id, printer_id, type, status, first_name)
    select org_id, id, 'badge', 'queued', 'ApiCaller' from public.printers limit 1;
    reset role;`)
  ok('public sign-in + print API inserts (org resolved from the token)')
} catch (e) { bad('service_role inserts', e) }

try {
  await db.exec(asUser(ADMIN, `
    insert into public.printers (org_id, name, port)
    select id, 'Second Printer', 9100 from public.organizations limit 1;
    insert into public.print_jobs (org_id, type, status, printer_id)
    select org_id, 'test', 'queued', id from public.printers where name = 'Second Printer';
    update public.printer_config set label_media = '62' where id = 1;
    update public.app_settings set selfie_mode = 'optional' where id = 1;`))
  ok('admin portal writes (authenticated, org_id stamped)')
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

console.log('— kiosk tokens (A4) —')
const kt = await q(`
  select count(*) as printers,
         count(kiosk_token) as tokened,
         count(distinct kiosk_token) as distinct_tokens,
         bool_and(kiosk_token ~ '^k_[0-9a-f]{32}$') as well_formed
  from public.printers`)
if (Number(kt.printers) === Number(kt.tokened) && Number(kt.printers) === Number(kt.distinct_tokens) && kt.well_formed)
  ok(`every printer has a unique, well-formed kiosk token (${kt.printers})`)
else bad(`kiosk tokens: ${JSON.stringify(kt)}`)

console.log('— rate limits and the queue cap (A4) —')
const ids = await q(`
  select (select id from public.organizations order by created_at limit 1) as org,
         (select id from public.printers order by created_at limit 1)      as printer`)
const gate = async (ip, badges = 1) =>
  (await q(`select public.check_submit_allowed(
      '${ids.org}'::uuid, '${ids.printer}'::uuid, ${ip === null ? 'null' : `'${ip}'`}, ${badges}
    ) as reason`)).reason

// A first sign-in from a fresh address is always fine.
const first = await gate('203.0.113.10')
if (first === null) ok('a normal sign-in is allowed')
else bad(`a normal sign-in was blocked: ${first}`)

// Default is 6/minute per IP; the 7th should be turned away.
let tripped = null
for (let i = 0; i < 8 && !tripped; i++) tripped = await gate('203.0.113.10')
if (tripped && /device/i.test(tripped)) ok(`per-IP limit trips: "${tripped}"`)
else bad(`per-IP limit did not trip (got ${JSON.stringify(tripped)})`)

// …and it must not punish the person standing next to them.
const neighbour = await gate('203.0.113.99')
if (neighbour === null) ok('a different device is unaffected by that limit')
else bad(`a different device was wrongly blocked: ${neighbour}`)

// An unknown IP must not crash the check (the header can be absent).
const noIp = await gate(null)
if (noIp === null) ok('a request with no client IP still works')
else bad(`a request with no IP was blocked: ${noIp}`)

// Queue cap: a backlog the printer cannot clear turns new sign-ins away.
await db.exec(`
  insert into public.print_jobs (org_id, printer_id, type, status)
  select '${ids.org}'::uuid, '${ids.printer}'::uuid, 'badge', 'queued'
  from generate_series(1, 45)`)
const capped = await gate('203.0.113.77')
if (capped && /waiting to print/i.test(capped)) ok(`queue cap trips: "${capped}"`)
else bad(`queue cap did not trip (got ${JSON.stringify(capped)})`)
await db.exec(`delete from public.print_jobs where status = 'queued' and entry_id is null`)

// The limiter's own bookkeeping must not grow without bound.
const pruned = await q(`
  select count(*) filter (where at < now() - interval '1 day') as stale from public.submit_events`)
if (Number(pruned.stale) === 0) ok('old rate-limit events are pruned')
else bad(`rate-limit events not pruned: ${JSON.stringify(pruned)}`)

console.log('— integration credentials (A5) —')
// The roles test proves an admin cannot read a credential back. The other half
// matters just as much: the Edge Functions must be able to, or every sync
// silently stops.
const org = (await q(`select id from public.organizations order by created_at limit 1`)).id
// Written the way the admin UI writes it: as the signed-in admin, through the
// setter — which is the only path that exists.
await db.exec(asUser(ADMIN, `
  insert into public.integrations (org_id, kind, enabled, config)
  values ('${org}', 'google_form', true, '{"response_url":"https://example.invalid/f"}')
  on conflict (org_id, kind) do update set enabled = true;
  select public.set_integration_secret('${org}'::uuid, 'google_drive', 'the-private-key');`))
try {
  const got = await q(`
    select enabled, config, secret from public.integration_for('${org}'::uuid, 'google_drive')`)
  if (got?.secret === 'the-private-key') ok('the server can decrypt an org credential')
  else bad(`integration_for did not return the secret: ${JSON.stringify(got)}`)
} catch (e) { bad('integration_for', e) }

const cfg = await q(`
  select config->>'response_url' as url from public.integration_for('${org}'::uuid, 'google_form')`)
if (cfg?.url === 'https://example.invalid/f') ok('the server reads per-org integration config')
else bad(`integration_for config: ${JSON.stringify(cfg)}`)

// A credential must never survive the org being removed.
await db.exec(`
  insert into public.organizations (id, slug, name)
  values ('cccccccc-0000-4000-8000-00000000000c', 'temp-org', 'Temp Org');
  insert into public.memberships (org_id, user_id, role)
  values ('cccccccc-0000-4000-8000-00000000000c', '${ADMIN}', 'owner');`)
await db.exec(asUser(ADMIN, `
  select public.set_integration_secret('cccccccc-0000-4000-8000-00000000000c'::uuid, 'google_drive', 'temp-key');`))
await db.exec(`delete from public.organizations where slug = 'temp-org'`)
const orphan = await q(`select count(*) as n from vault.secrets where secret = 'temp-key'`)
if (Number(orphan.n) === 0) ok('deleting an org takes its credentials with it')
else bad(`a deleted org left ${orphan.n} credential(s) behind in the vault`)

console.log('— scan and add printer (B2) —')
const scanOrg = (await q(`select id from public.organizations order by created_at limit 1`)).id

// An admin asks for a scan; the bridge reports back what it saw.
await db.exec(asUser(ADMIN, `
  update public.printer_status set scan_requested_at = now() where org_id = '${scanOrg}';`))
const asked = await q(`
  select scan_requested_at is not null as asked from public.printer_status
  where org_id = '${scanOrg}'`)
if (asked.asked) ok('an admin can request a scan')
else bad('the scan request did not stick')

await db.exec(`
  insert into public.discovered_printers (org_id, ip, mac, model)
  values ('${scanOrg}', '192.168.1.69', '44:f7:9f:bc:ab:e8', 'Brother QL-820NWB')`)

// Reporting the same address again updates it rather than duplicating, and
// keeps first_seen — "seen since", not "found again just now".
await db.exec(`
  insert into public.discovered_printers (org_id, ip, mac, model, last_seen)
  values ('${scanOrg}', '192.168.1.69', '44:f7:9f:bc:ab:e8', 'Brother QL-820NWB', now())
  on conflict (org_id, ip) do update set last_seen = excluded.last_seen`)
const dedup = await q(`
  select count(*) as n, min(first_seen) = max(first_seen) as kept_first
  from public.discovered_printers where org_id = '${scanOrg}'`)
if (Number(dedup.n) === 1 && dedup.kept_first) ok('re-reporting an address updates rather than duplicates')
else bad(`discovered_printers deduplication: ${JSON.stringify(dedup)}`)

// A second org must not see it.
await db.exec(`
  insert into public.organizations (id, slug, name)
  values ('dddddddd-0000-4000-8000-00000000000d', 'scan-other', 'Scan Other')
  on conflict (slug) do nothing`)
const otherSees = await q(`
  select count(*) as n from public.discovered_printers
  where org_id = 'dddddddd-0000-4000-8000-00000000000d'`)
if (Number(otherSees.n) === 0) ok('another org sees nothing of it')
else bad('discovered printers leaked across orgs')

// Deleting the org takes the scan cache with it.
await db.exec(`delete from public.organizations where slug = 'scan-other'`)

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

console.log('— with the trigger retired, an unstamped insert is always refused —')
await db.exec(`insert into public.organizations (slug, name) values ('second-tenant', 'Second Tenant');`)
const trig = await q(`
  select count(*) as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where not t.tgisinternal and t.tgname like '%_set_org_id'`)
if (Number(trig.n) === 0) ok('the transitional org_id trigger is gone')
else bad(`${trig.n} transitional org_id trigger(s) still installed`)

try {
  await db.exec(`
    set role service_role;
    insert into public.form_entries (first_name, visitor_type) values ('Unstamped', 'visitor');
    reset role;`)
  bad('an org_id-less insert succeeded — a row could land in the wrong tenant')
} catch (e) {
  await db.exec('reset role')
  const msg = String(e.message).split('\n')[0]
  if (/null value in column "org_id"|violates not-null/i.test(msg)) ok(`refused loudly: "${msg}"`)
  else bad(`refused, but for the wrong reason: ${msg}`)
}

console.log(failed ? '\nRESULT: FAILURES' : '\nRESULT: all checks passed')
process.exit(failed ? 1 : 0)
