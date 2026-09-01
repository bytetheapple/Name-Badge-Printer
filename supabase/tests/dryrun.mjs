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

-- Supabase's own default privileges, which the stub used to omit. Every table
-- created in public is granted ALL to the Data API roles, so a migration that
-- carefully grants SELECT and nothing else still ends up with INSERT, UPDATE,
-- DELETE, TRUNCATE, REFERENCES and TRIGGER attached to anon and authenticated.
-- RLS still stands in front of the DML — but TRUNCATE is not an RLS-checked
-- operation, and "I only granted SELECT" is a belief this harness must be able
-- to falsify rather than share.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;

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
  insert into public.integrations (org_id, kind, name, enabled, config)
  values ('${org}', 'google_form', 'Google Form', true, '{"response_url":"https://example.invalid/f"}')
  on conflict (org_id, lower(btrim(name))) do update set enabled = true;
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

console.log('— routing: which destinations one sign-in reaches —')
// The whole point of the rework: many destinations per kind, and a printer
// that can differ from the default. Seeded directly rather than through the
// admin, because these are the rows the sync path reads, not the ones a person
// types.
{
  const printer = (await q(`select id from public.printers order by created_at limit 1`)).id
  const entry = (await q(
    `select id from public.form_entries where printer_id = '${printer}' order by created_at limit 1`))?.id
  if (!entry) bad('routing: no seeded entry with a printer to test against')
  else {
    await db.exec(`
      insert into public.integrations (org_id, kind, name, enabled, default_enabled, config) values
        ('${org}', 'shulcloud', 'Main office',  true, true,  '{"form_url":"https://a.invalid"}'),
        ('${org}', 'shulcloud', 'Youth group',  true, true,  '{"form_url":"https://b.invalid"}'),
        ('${org}', 'shulcloud', 'Off by default', true, false, '{"form_url":"https://c.invalid"}'),
        ('${org}', 'shulcloud', 'Switched off', false, true,  '{"form_url":"https://d.invalid"}');`)

    const names = async () =>
      (await db.query(
        `select name from public.integration_targets('${entry}'::uuid, 'shulcloud') order by name`))
        .rows.map((r) => r.name)

    // Both defaults-on instances, and neither the disabled one nor the one
    // that is off by default.
    let got = await names()
    if (JSON.stringify(got) === JSON.stringify(['Main office', 'Youth group'])) {
      ok(`two destinations of one kind, defaults respected: ${got.join(', ')}`)
    } else bad(`routing returned ${JSON.stringify(got)}`)

    // A printer exception overrides the default in both directions at once.
    await db.exec(`
      insert into public.printer_integrations (printer_id, integration_id, org_id, enabled)
      select '${printer}', i.id, '${org}', (i.name = 'Off by default')
      from public.integrations i
      where i.org_id = '${org}' and i.name in ('Youth group', 'Off by default');`)
    got = await names()
    if (JSON.stringify(got) === JSON.stringify(['Main office', 'Off by default'])) {
      ok(`a printer exception overrides the default both ways: ${got.join(', ')}`)
    } else bad(`routing with overrides returned ${JSON.stringify(got)}`)

    // Resetting a printer to the default is a delete, and puts it back.
    await db.exec(
      `delete from public.printer_integrations where printer_id = '${printer}';`)
    got = await names()
    if (JSON.stringify(got) === JSON.stringify(['Main office', 'Youth group'])) {
      ok('deleting the exceptions restores the defaults')
    } else bad(`routing after reset returned ${JSON.stringify(got)}`)

    // A delivery per destination, and a retry updates rather than duplicates.
    const target = (await q(
      `select id from public.integration_targets('${entry}'::uuid, 'shulcloud') order by name limit 1`)).id
    await db.exec(`select public.record_delivery('${entry}'::uuid, '${target}'::uuid, 'failed', 'first try');`)
    await db.exec(`select public.record_delivery('${entry}'::uuid, '${target}'::uuid, 'sent', null);`)
    const d = await q(`
      select count(*)::int as n, max(status) as status
      from public.entry_deliveries where entry_id = '${entry}' and integration_id = '${target}'`)
    if (d.n === 1 && d.status === 'sent') ok('a retry updates the delivery rather than adding one')
    else bad(`delivery rows: ${JSON.stringify(d)}`)

    await db.exec(`
      delete from public.entry_deliveries where entry_id = '${entry}';
      delete from public.integrations where org_id = '${org}' and kind = 'shulcloud';`)
  }
}

console.log('— reflashing a print server revokes what the old card holds —')
// The claim code is the visible half. The half that matters is that every
// credential the device ever held stops working, including the ones it rotated
// to after being claimed — otherwise the SD card in a drawer still
// authenticates for that congregation.
{
  await db.exec(`
    -- Reissuing is an operator's job and the harness's ADMIN is only an org
    -- owner, so give it operator standing for the length of this block.
    insert into public.platform_admins (user_id, role) values ('${ADMIN}', 'owner')
      on conflict (user_id) do nothing;

    insert into public.pi_devices (serial, org_id, customer, claim_hash, claim_prefix)
    values ('GuestBadgesServerTEST', '${org}', 'Test Congregation', 'hash-test', 'gbc_test');

    -- Issued, then rotated twice, which is where a device that has been in
    -- service for a few months actually sits.
    insert into public.bridge_tokens (id, org_id, name, token_hash, token_prefix, first_used_at)
    values ('11110000-0000-4000-8000-000000000001', '${org}', 'issued',  'h1', 'nbk_1', now());
    insert into public.bridge_tokens (id, org_id, name, token_hash, token_prefix, replaces, first_used_at)
    values ('11110000-0000-4000-8000-000000000002', '${org}', 'rotated', 'h2', 'nbk_2',
            '11110000-0000-4000-8000-000000000001', now());
    insert into public.bridge_tokens (id, org_id, name, token_hash, token_prefix, replaces)
    values ('11110000-0000-4000-8000-000000000003', '${org}', 'current', 'h3', 'nbk_3',
            '11110000-0000-4000-8000-000000000002');

    update public.pi_devices
       set bridge_token_id = '11110000-0000-4000-8000-000000000001',
           claimed_at = now(), last_seen = now(), running_ref = 'abc1234'
     where serial = 'GuestBadgesServerTEST';`)

  const res = await db.exec(asUser(ADMIN,
    `select public.reissue_pi_device('GuestBadgesServerTEST') as r;`))
  const out = res.filter((r) => r.rows?.length).pop()?.rows?.[0]?.r

  if (out?.claim_code?.startsWith('gbc_')) ok('a fresh claim code is returned')
  else bad(`reissue returned ${JSON.stringify(out)}`)

  const live = await q(`
    select count(*)::int as n from public.bridge_tokens
    where id in ('11110000-0000-4000-8000-000000000001',
                 '11110000-0000-4000-8000-000000000002',
                 '11110000-0000-4000-8000-000000000003')
      and revoked_at is null`)
  if (live.n === 0) ok('every credential along the rotation chain is revoked')
  else bad(`${live.n} credential(s) still live after a reissue`)

  const dev = await q(`
    select claimed_at, bridge_token_id, last_seen, running_ref, claim_prefix
    from public.pi_devices where serial = 'GuestBadgesServerTEST'`)
  if (!dev.claimed_at && !dev.bridge_token_id && !dev.last_seen && !dev.running_ref) {
    ok('the device reads as unclaimed again, with no stale heartbeat')
  } else bad(`device not reset: ${JSON.stringify(dev)}`)
  if (dev.claim_prefix !== 'gbc_test') ok('the old claim code no longer opens it')
  else bad('the claim code was not replaced')

  // Moving it to another organization tells both sides.
  await db.exec(asUser(ADMIN,
    `select public.reissue_pi_device('GuestBadgesServerTEST',
       '${org}'::uuid, 'Second Congregation');`))
  const logged = await q(`
    select count(*)::int as n from public.activity_log
    where action = 'device.reissue' and subject = 'GuestBadgesServerTEST'`)
  if (logged.n >= 2) ok('each reissue is on the record')
  else bad(`reissue logged ${logged.n} row(s)`)

  // Description is editable; the guarded fields are not reachable from here.
  await db.exec(asUser(ADMIN,
    `select public.update_pi_device('GuestBadgesServerTEST', 'Renamed Congregation', 'shelf 3');`))
  const edited = await q(`
    select customer, notes from public.pi_devices where serial = 'GuestBadgesServerTEST'`)
  if (edited.customer === 'Renamed Congregation' && edited.notes === 'shelf 3') {
    ok('customer and notes can be corrected')
  } else bad(`edit produced ${JSON.stringify(edited)}`)

  // A claimed device is kept. This one was just reissued, so it is unclaimed —
  // claim it back to prove the guard, then leave it unclaimed for the delete.
  await db.exec(
    `update public.pi_devices set claimed_at = now() where serial = 'GuestBadgesServerTEST';`)
  let refused = false
  try {
    await db.exec(asUser(ADMIN, `select public.delete_pi_device('GuestBadgesServerTEST');`))
  } catch (e) {
    refused = String(e.message).includes('has been claimed')
  }
  if (refused) ok('a claimed device cannot be deleted, only reflashed')
  else bad('a claimed device was deleted')

  await db.exec(
    `update public.pi_devices set claimed_at = null where serial = 'GuestBadgesServerTEST';`)
  await db.exec(asUser(ADMIN, `select public.delete_pi_device('GuestBadgesServerTEST');`))
  const gone = await q(
    `select count(*)::int as n from public.pi_devices where serial = 'GuestBadgesServerTEST'`)
  if (gone.n === 0) ok('a build clicked by mistake can be removed')
  else bad('the unclaimed device survived deletion')

  // A chain longer than any cap anyone would think to write. This is the case
  // the depth guard got wrong in production: it revoked the first fifty and
  // left the rest — including the newest, which are the ones that still
  // authenticate — on a card that had already been rewritten.
  await db.exec(`
    insert into public.pi_devices (serial, org_id, customer, claim_hash, claim_prefix)
    values ('GuestBadgesServerLONG', '${org}', 'Long', 'hash-long', 'gbc_long');
    do $$
    declare prev uuid := null; cur uuid;
    begin
      for i in 1..120 loop
        insert into public.bridge_tokens (org_id, name, token_hash, token_prefix, replaces)
        values ('${org}', 'chain' || i, 'hc' || i, 'nbkc_' || i, prev)
        returning id into cur;
        if i = 1 then
          update public.pi_devices set bridge_token_id = cur, claimed_at = now()
           where serial = 'GuestBadgesServerLONG';
        end if;
        prev := cur;
      end loop;
    end $$;`)

  await db.exec(asUser(ADMIN, `select public.reissue_pi_device('GuestBadgesServerLONG');`))
  const longLive = await q(`
    select count(*)::int as n from public.bridge_tokens
    where token_prefix like 'nbkc\\_%' and revoked_at is null`)
  if (longLive.n === 0) ok('a 120-link chain is revoked to its end, not to a cap')
  else bad(`${longLive.n} credential(s) survived a long chain — the walk stopped early`)

  await db.exec(`
    delete from public.pi_devices where serial = 'GuestBadgesServerLONG';
    delete from public.bridge_tokens where token_prefix like 'nbkc\\_%';
    delete from public.activity_log where subject = 'GuestBadgesServerLONG';`)

  // A cycle in the rotation graph. It should not be possible, but the walk has
  // to end whether or not that holds — unbounded, this recursed until the
  // statement timeout killed it, which is how it was found.
  await db.exec(`
    insert into public.pi_devices (serial, org_id, customer, claim_hash, claim_prefix)
    values ('GuestBadgesServerLOOP', '${org}', 'Loop', 'hash-loop', 'gbc_loop');
    insert into public.bridge_tokens (id, org_id, name, token_hash, token_prefix)
    values ('22220000-0000-4000-8000-000000000001', '${org}', 'a', 'ha', 'nbk_a'),
           ('22220000-0000-4000-8000-000000000002', '${org}', 'b', 'hb', 'nbk_b');
    update public.bridge_tokens set replaces = '22220000-0000-4000-8000-000000000002'
      where id = '22220000-0000-4000-8000-000000000001';
    update public.bridge_tokens set replaces = '22220000-0000-4000-8000-000000000001'
      where id = '22220000-0000-4000-8000-000000000002';
    update public.pi_devices set bridge_token_id = '22220000-0000-4000-8000-000000000001',
           claimed_at = now()
     where serial = 'GuestBadgesServerLOOP';`)

  const began = Date.now()
  await db.exec(asUser(ADMIN, `select public.reissue_pi_device('GuestBadgesServerLOOP');`))
  const took = Date.now() - began
  const loop = await q(`
    select count(*)::int as n from public.bridge_tokens
    where token_prefix in ('nbk_a','nbk_b') and revoked_at is null`)
  if (loop.n === 0 && took < 5000) ok(`a cycle in the chain still terminates (${took}ms)`)
  else bad(`cycle case: ${loop.n} live token(s) after ${took}ms`)

  await db.exec(`
    delete from public.pi_devices where serial = 'GuestBadgesServerLOOP';
    delete from public.bridge_tokens where token_prefix in ('nbk_a','nbk_b');
    delete from public.activity_log where subject = 'GuestBadgesServerLOOP';
    delete from public.pi_devices where serial = 'GuestBadgesServerTEST';
    delete from public.bridge_tokens where token_prefix in ('nbk_1','nbk_2','nbk_3');
    delete from public.activity_log where subject = 'GuestBadgesServerTEST';
    delete from public.platform_admins where user_id = '${ADMIN}';
    delete from public.activity_log where action like 'operator.%';`)
}

console.log('— discovered_printers, retained but no longer written (B2) —')
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

console.log('— negative control: without the trigger, an org lifts its own suspension —')
// Suspension is only a lever if a tenant cannot pull it. A2's update policy on
// organizations is column-blind, so the trigger is the whole of the guard.
const unguarded = await build((sql, f) =>
  f.includes('_mt_a6_platform')
    ? sql.replace(
        `    if new.status is distinct from old.status then
      raise exception 'an organization''s status is set by the Name Badge Kiosk team'
        using errcode = 'insufficient_privilege';
    end if;`,
        '')
    : sql)
try {
  await unguarded.exec(ROLES)
  bad('negative control: an owner changed their own status and the test PASSED')
} catch (e) {
  const msg = String(e.message).split('\n')[0]
  if (msg.includes('changed their own organization status')) ok(`without the guard it is caught: "${msg}"`)
  else bad(`negative control failed for the wrong reason: ${msg}`)
}

console.log('— operator role test (operators) —')
const OPS = readFileSync(path.join(REPO, 'supabase/tests/operators_test.sql'), 'utf8')
try {
  const res = await db.exec(OPS)
  const rows = res.filter((r) => r.rows?.length).pop()?.rows ?? []
  if (!rows.length) bad('operators_test.sql produced no result table')
  else if (rows.some((r) => r.result !== 'pass')) bad('operators_test.sql reported a non-pass row')
  else if (rows.at(-1).check_name !== 'ALL CHECKS PASSED') bad('operators_test.sql did not end with ALL CHECKS PASSED')
  else ok(`operators_test.sql passed, ${rows.length} checks reported in its result table`)
} catch (e) {
  bad('operators_test.sql', e)
  await db.exec('rollback').catch(() => {})
}

console.log('— negative control: the operator role must actually gate something —')
// The whole reason for the role column is that `status` once sat unread while
// suspension silently did nothing. Take the owner check out of
// delete_organization and a support operator must be caught deleting a tenant.
const roleBlindOps = await build((sql, f) =>
  f.includes('_mt_operators')
    ? sql.replace(
        `  if not coalesce(public.is_platform_owner(), false) then
    raise exception 'deleting an organization is reserved for an owner; suspending is not'
      using errcode = 'insufficient_privilege';
  end if;`,
        '')
    : sql)
try {
  await roleBlindOps.exec(OPS)
  bad('negative control: a support operator deleted an organization and the test PASSED')
} catch (e) {
  const msg = String(e.message).split('\n')[0]
  if (msg.includes('support operator deleted an organization')) ok(`without the owner check it is caught: "${msg}"`)
  else bad(`operator negative control failed for the wrong reason: ${msg}`)
}

console.log('— negative control: an unrecorded action must FAIL the operator test —')
// A trigger that silently does nothing is indistinguishable from one that
// works, which is the whole reason the log is asserted rather than assumed.
const unlogged = await build((sql, f) =>
  f.includes('_mt_operator_activity')
    ? sql.replace(
        `create trigger organizations_activity
  after insert or update on public.organizations
  for each row execute function public.log_organization_activity();`,
        'select 1;')
    : sql)
try {
  await unlogged.exec(OPS)
  bad('negative control: org actions went unlogged and the test PASSED')
} catch (e) {
  const msg = String(e.message).split('\n')[0]
  if (msg.includes('logged 0 row(s)')) ok(`an unrecorded action is caught: "${msg}"`)
  else bad(`activity negative control failed for the wrong reason: ${msg}`)
}

console.log('— negative control: without the last-owner guard, the console locks itself out —')
// platform_admins has no insert policy, so an account that demotes the last
// owner cannot promote anyone back. Recovery would mean the SQL editor.
const noLastOwner = await build((sql, f) =>
  f.includes('_mt_operators')
    ? sql.replace(
        `  if v_current = 'owner' and p_role <> 'owner'
     and (select count(*) from public.platform_admins where role = 'owner') = 1 then
    raise exception 'this is the last owner; promote someone else first';
  end if;`,
        '')
    : sql)
try {
  await noLastOwner.exec(OPS)
  bad('negative control: the last owner demoted themselves and the test PASSED')
} catch (e) {
  const msg = String(e.message).split('\n')[0]
  if (msg.includes('sole owner demoted themselves')) ok(`without the guard it is caught: "${msg}"`)
  else bad(`last-owner negative control failed for the wrong reason: ${msg}`)
}

console.log('— negative control: without the trigger, an owner grants themselves a paid feature —')
// A2's "owner updates organization" policy is column-blind, so the guard is the
// only thing standing between an owner and the capability flag on their own row.
// Remove the trigger outright. Renaming it does not disable it — a trigger
// fires on its event, not on its name — and a control that does not actually
// remove the guard proves nothing.
const ungated = await build((sql, f) =>
  f.includes('_mt_custom_integrations')
    ? sql.replace(
        `create trigger organizations_custom_integrations_guard
  before update on public.organizations
  for each row execute function public.enforce_custom_integrations_grant();`,
        'select 1;')
    : sql)
try {
  await ungated.exec(ROLES)
  bad('negative control: an owner enabled custom integrations and the test PASSED')
} catch (e) {
  const msg = String(e.message).split('\n')[0]
  if (msg.includes('enabled custom integrations')) ok(`without the guard it is caught: "${msg}"`)
  else bad(`negative control failed for the wrong reason: ${msg}`)
}

console.log('— negative control: dropping either half of the B3 revoke must FAIL —')
// A new function is EXECUTE-to-PUBLIC by default *and* this project grants the
// Data API roles EXECUTE by name. Removing either revoke leaves the WiFi
// passphrase readable from the browser, so both must be shown to bite.
for (const [label, from, to] of [
  ['the PUBLIC half', 'from public, anon, authenticated;', 'from anon, authenticated;'],
  ['the named-role half', 'from public, anon, authenticated;', 'from public;'],
]) {
  const weak = await build((sql, f) => (f.includes('_mt_b3_') ? sql.replace(from, to) : sql))
  try {
    await weak.exec(TEST)
    bad(`negative control: dropping ${label} of the revoke still PASSED — the test is not checking`)
  } catch (e) {
    const msg = String(e.message).split('\n')[0]
    if (msg.includes("decrypted another org's WiFi passphrase")) ok(`dropping ${label} is caught`)
    else bad(`negative control (${label}) failed for the wrong reason: ${msg}`)
  }
}

console.log('— no table hands TRUNCATE to the Data API roles —')
// TRUNCATE is not an RLS-checked operation: a role holding it empties the
// table, policies and all. Supabase's default privileges grant it on every new
// table, so this is a standing invariant rather than a one-off cleanup — the
// next table added will arrive with it unless the default is also revoked.
const loose = await db.query(`
  select table_name, privilege_type
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')
  order by table_name, privilege_type`)
if (loose.rows.length === 0) ok('anon and authenticated hold no TRUNCATE on any public table')
else {
  bad(`${loose.rows.length} unwanted grant(s), e.g. ` +
      loose.rows.slice(0, 4).map((r) => `${r.table_name}:${r.privilege_type}`).join(', '))
}

// And that the check bites: without the revoke the grants must be there, or
// the assertion above is agreeing with a stub rather than testing anything.
const noRevoke = await build((sql, f) => (f.includes('_mt_table_grants') ? 'select 1;' : sql))
const still = await noRevoke.query(`
  select count(*)::int as n
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')`)
if (still.rows[0].n > 0) {
  ok(`negative control: without the revoke, ${still.rows[0].n} such grant(s) exist`)
} else {
  bad('negative control: the grants were absent even without the revoke — the check proves nothing')
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
