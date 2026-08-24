-- ============================================================================
-- Security fix — server-only functions were executable by any signed-in user
--
-- `integration_for()` and `check_submit_allowed()` are SECURITY DEFINER and
-- take an org_id as an argument, so they are only safe if nothing but the Edge
-- Functions can call them. Both were locked with:
--
--     revoke all on function … from public;
--     grant execute on function … to service_role;
--
-- which is not enough. **Revoking from PUBLIC does not remove a direct grant to
-- a role**, and this project grants the Data API roles EXECUTE on newly created
-- functions — a grant made when the function was created, before the revoke ran.
--
-- The consequence was real: `integration_for(<any org>, 'google_drive')` would
-- have returned that organization's decrypted Google credential to any
-- authenticated user, in any org. RLS could not help — the function is
-- SECURITY DEFINER precisely so it can bypass it.
--
-- Idempotent, and safe to run more than once.
-- ============================================================================

revoke all on function public.integration_for(uuid, text)
  from anon, authenticated;

revoke all on function
  public.check_submit_allowed(uuid, uuid, text, int, int, int, int, interval)
  from anon, authenticated;

-- The Edge Functions still need them.
grant execute on function public.integration_for(uuid, text) to service_role;
grant execute on function
  public.check_submit_allowed(uuid, uuid, text, int, int, int, int, interval)
  to service_role;

-- Verify: neither should list anon or authenticated.
select p.proname,
       coalesce(pg_catalog.array_to_string(p.proacl, ' | '), '(owner only)') as grants
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('integration_for', 'check_submit_allowed')
order by p.proname;
