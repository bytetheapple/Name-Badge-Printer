-- ============================================================================
-- Read one integration's credential, by the integration
--
-- integration_for(org, kind) returns a *set* — it predates integrations being
-- many-per-kind, and every caller takes the first row of it. That was right
-- when a kind could only appear once per organization and is now a guess: with
-- two Google connections it reads whichever row the planner happened to return.
--
-- Fine for the syncs, which iterate targets. Not fine for anything asked about
-- a specific connection, which is the whole point of a test button.
--
-- Additive; the existing function is untouched.
-- ============================================================================

create or replace function public.integration_secret(p_integration uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select (select s.decrypted_secret
            from vault.decrypted_secrets s
           where s.id = i.secret_id)
    from public.integrations i
   where i.id = p_integration
$$;

-- Server-only, and both revokes matter: this returns a decrypted credential,
-- and a new function is executable by PUBLIC by default.
revoke all on function public.integration_secret(uuid) from public, anon, authenticated;
grant execute on function public.integration_secret(uuid) to service_role;

select p.proname,
       coalesce(pg_catalog.array_to_string(p.proacl, ' | '), '(owner only)') as grants
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'integration_secret';
