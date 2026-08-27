-- ============================================================================
-- Taking back the privileges nobody asked for
--
-- Supabase sets default privileges that grant ALL on every new table in public
-- to anon and authenticated. So a migration that carefully grants SELECT and
-- nothing else still ends up with INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES
-- and TRIGGER attached to both roles. The previous migration's own verify
-- query reported six such grants on activity_log, against a comment in that
-- file claiming the absence of a write grant was what made the log
-- tamper-evident. It was not. RLS was.
--
-- For INSERT/UPDATE/DELETE that distinction is academic: RLS stands in front
-- of all three, and a table with no write policy refuses writes whatever the
-- grant says. TRUNCATE is the one that matters, because **TRUNCATE is not an
-- RLS-checked operation**. A role holding it can empty a table outright,
-- policies and all. PostgREST does not expose TRUNCATE, so this was not
-- reachable from the Data API — but "unreachable through the front door we
-- happen to ship today" is not the same as "not granted", and one
-- SECURITY INVOKER function would close that gap without anyone noticing.
--
-- So: TRUNCATE, REFERENCES and TRIGGER go back, everywhere. None of the three
-- is used by anything in this project.
--
-- Additive and idempotent.
-- ============================================================================

do $$
declare
  r record;
begin
  for r in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format(
      'revoke truncate, references, trigger on public.%I from anon, authenticated',
      r.tablename);
  end loop;
end;
$$;

-- And for tables created after this runs, so the next one does not quietly
-- arrive with the same three attached.
alter default privileges in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;

-- ------------------------------------------------ activity_log, as intended
-- The log's whole value is that its subject cannot edit it. RLS already
-- refuses every write for want of a policy; removing the grants as well means
-- the intent is legible from the privileges rather than inferable from the
-- absence of something.
revoke insert, update, delete on public.activity_log from anon, authenticated;
grant select on public.activity_log to authenticated;

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice. Both numbers must be zero.
select
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated')
      and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER'))          as truncate_like_grants,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'activity_log'
      and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT') as activity_log_writes;
