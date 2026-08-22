-- ============================================================================
-- Tenant isolation test — Phase A1
--
-- Proves the property from MULTI_TENANT_DESIGN.md §15: logged in as org A you
-- see ZERO rows of org B (and of every other org, including the real one) on
-- every tenant table, and you cannot write into another org.
--
-- HOW TO RUN: paste the whole file into the Supabase SQL editor and run it.
--   * It runs inside BEGIN … ROLLBACK, so it writes nothing: the two test orgs,
--     users and rows are gone when it finishes, pass or fail.
--   * Success  -> the final notice reads "TENANT ISOLATION: ALL CHECKS PASSED".
--   * Failure  -> it raises an exception naming the table that leaked, and the
--     transaction rolls back.
--
-- Run it after each of the three A1 migrations is applied, and again after any
-- future change to a policy, a helper function or a tenant table.
-- ============================================================================

begin;

-- Impersonation below only works if the current role is not exempt from RLS.
-- (Table owners and superusers bypass policies, which would make this test
-- pass vacuously; `set role authenticated` is what makes it real.)

-- ---------------------------------------------------------------- seed data
-- Fixed ids so the assertions can be written as literals.

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'isolation-test-a@example.invalid'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'isolation-test-b@example.invalid');

insert into public.organizations (id, slug, name) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'isolation-test-a', 'Isolation Test A'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'isolation-test-b', 'Isolation Test B');

insert into public.memberships (org_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'owner'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000001', 'owner');

insert into public.printers (id, org_id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000000f1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'A printer'),
  ('bbbbbbbb-0000-4000-8000-0000000000f1', 'bbbbbbbb-0000-4000-8000-00000000000b', 'B printer');

insert into public.form_entries (org_id, printer_id, first_name, last_name) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'Ada', 'Alpha'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-0000000000f1', 'Ben', 'Bravo');

insert into public.print_jobs (org_id, printer_id, type, status) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-0000000000f1', 'badge', 'queued'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-0000000000f1', 'badge', 'queued');

insert into public.printer_config (org_id) values
  ('aaaaaaaa-0000-4000-8000-00000000000a'),
  ('bbbbbbbb-0000-4000-8000-00000000000b');

insert into public.printer_status (org_id) values
  ('aaaaaaaa-0000-4000-8000-00000000000a'),
  ('bbbbbbbb-0000-4000-8000-00000000000b');

insert into public.app_settings (org_id) values
  ('aaaaaaaa-0000-4000-8000-00000000000a'),
  ('bbbbbbbb-0000-4000-8000-00000000000b');

-- Only user B is a platform admin, so user A must not see this table at all
-- and user B must see exactly their own row.
insert into public.platform_admins (user_id)
values ('bbbbbbbb-0000-4000-8000-000000000001');

-- ------------------------------------------------------ checks: as org A user

set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

do $$
declare
  mine  constant uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  other constant uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  tbl   text;
  n     bigint;
begin
  -- READ isolation on every tenant table. "foreign" counts every row that is
  -- not this org's — org B's *and* any real tenant's — so a policy that leaks
  -- production data fails here too.
  foreach tbl in array array[
    'form_entries', 'print_jobs', 'printers',
    'printer_config', 'printer_status', 'app_settings'
  ] loop
    execute format('select count(*) from public.%I where org_id <> $1', tbl)
      into n using mine;
    if n <> 0 then
      raise exception 'ISOLATION FAILURE: org A can read % foreign row(s) in %', n, tbl;
    end if;

    execute format('select count(*) from public.%I where org_id = $1', tbl)
      into n using mine;
    if n < 1 then
      raise exception 'TEST BROKEN: org A cannot read its own row in % (RLS too tight, or the seed did not land)', tbl;
    end if;
  end loop;

  -- The org/membership tables themselves.
  select count(*) into n from public.organizations where id <> mine;
  if n <> 0 then
    raise exception 'ISOLATION FAILURE: org A can read % foreign organization row(s)', n;
  end if;
  select count(*) into n from public.organizations where id = mine;
  if n <> 1 then
    raise exception 'TEST BROKEN: org A cannot read its own organization row';
  end if;

  select count(*) into n from public.memberships where org_id <> mine;
  if n <> 0 then
    raise exception 'ISOLATION FAILURE: org A can read % foreign membership(s)', n;
  end if;

  -- A is not a platform admin, so the operator list must be invisible.
  select count(*) into n from public.platform_admins;
  if n <> 0 then
    raise exception 'ISOLATION FAILURE: a tenant user can read platform_admins (% row(s))', n;
  end if;

  -- WRITE isolation: inserting into another org must be refused outright.
  begin
    insert into public.print_jobs (org_id, printer_id, type, status)
    values (other, 'bbbbbbbb-0000-4000-8000-0000000000f1', 'badge', 'queued');
    raise exception 'ISOLATION FAILURE: org A inserted a print_job into org B';
  exception
    when insufficient_privilege then null;  -- expected: RLS WITH CHECK refused it
  end;

  -- …and an update/delete aimed at another org must simply match nothing.
  update public.printers set name = 'hijacked' where org_id = other;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'ISOLATION FAILURE: org A updated % of org B''s printers', n;
  end if;

  delete from public.printers where org_id = other;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'ISOLATION FAILURE: org A deleted % of org B''s printers', n;
  end if;

  raise notice 'org A: read + write isolation ok';
end;
$$;

-- ------------------------------------------------------ checks: as org B user
-- Symmetric direction, plus the platform-admin read path.

reset role;
set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

do $$
declare
  mine  constant uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  tbl   text;
  n     bigint;
begin
  -- B *is* a platform admin, so B legitimately reads across orgs. Isolation for
  -- B is therefore asserted on the tables platform admins get no policy for:
  -- they may read tenant data, but must not gain writes or another org's
  -- membership-derived powers.
  foreach tbl in array array['printers', 'printer_config', 'app_settings'] loop
    execute format(
      'update public.%I set org_id = org_id where org_id <> $1', tbl) using mine;
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception
        'ISOLATION FAILURE: platform admin wrote % foreign row(s) in % (read-only expected)', n, tbl;
    end if;
  end loop;

  -- The platform-admin read policy works, and shows only their own row here.
  select count(*) into n from public.platform_admins;
  if n <> 1 then
    raise exception 'platform_admins should expose exactly the caller''s row, saw %', n;
  end if;

  select count(*) into n from public.organizations;
  if n < 2 then
    raise exception 'TEST BROKEN: platform admin should read across orgs, saw % organization(s)', n;
  end if;

  -- Membership-scoped writes still apply: B owns org B and may insert there.
  insert into public.print_jobs (org_id, printer_id, type, status)
  values (mine, 'bbbbbbbb-0000-4000-8000-0000000000f1', 'test', 'queued');

  raise notice 'org B / platform admin: read + write scoping ok';
end;
$$;

-- --------------------------------------------------------- checks: as anon
-- The public sign-in form uses the anon key; it must reach nothing directly.

reset role;
set local request.jwt.claims = '';
set local role anon;

do $$
declare
  tbl text;
  n   bigint;
begin
  foreach tbl in array array[
    'form_entries', 'print_jobs', 'printers', 'printer_config',
    'printer_status', 'app_settings', 'organizations', 'memberships',
    'platform_admins'
  ] loop
    begin
      execute format('select count(*) from public.%I', tbl) into n;
      if n <> 0 then
        raise exception 'ISOLATION FAILURE: anon can read % row(s) of %', n, tbl;
      end if;
    exception
      when insufficient_privilege then null;  -- no grant at all: even better
    end;
  end loop;

  raise notice 'anon: no table access ok';
end;
$$;

reset role;

do $$
begin
  raise notice 'TENANT ISOLATION: ALL CHECKS PASSED';
end;
$$;

rollback;
