-- ============================================================================
-- Photographs are ready when *either* credential is there
--
-- integration_ready(org, 'google_drive') asks whether the destination has a
-- service-account key and a client email. That was the only way to reach Drive
-- when it was written. It is now the way we are retiring, and an organization
-- set up the new way — connect Google, no key, no email — reads as not ready.
--
-- The visible effect: Settings offers "No selfie" and disables the other two,
-- so an organization that has connected Google cannot switch photographs on at
-- all. Nothing is broken except the question being asked.
--
-- So ask the real one: is there any credential that can write to this
-- organization's Drive.
--
-- Additive; replaces the function body only.
-- ============================================================================

create or replace function public.integration_ready(p_org uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.integrations i
    where i.org_id = p_org
      and i.kind = p_kind
      and i.enabled
      and case p_kind
            when 'google_drive' then
              -- Its own service account, the original path …
              (i.secret_id is not null
                and coalesce(i.config ->> 'sa_client_email', '') <> '')
              -- … or the organization's connected Google account, which holds
              -- the credential centrally and leaves this destination with none
              -- of its own.
              or exists (
                select 1 from public.integrations o
                 where o.org_id = p_org
                   and o.kind = 'google_oauth'
                   and o.enabled
                   and o.secret_id is not null
              )
            else true
          end
      and public.auth_is_org_admin(p_org)
  )
$$;

-- Unchanged from the original: an admin asking about their own organization.
revoke all on function public.integration_ready(uuid, text) from public, anon;
grant execute on function public.integration_ready(uuid, text) to authenticated, service_role;

select o.name,
       public.integration_ready(o.id, 'google_drive') as selfies_possible
  from public.organizations o
 order by o.name;
