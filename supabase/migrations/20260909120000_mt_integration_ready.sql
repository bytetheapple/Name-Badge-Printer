-- ============================================================================
-- "Is this integration usable?" — a question an admin may ask
--
-- Integrations moved to the owner, credentials and all. But whether selfies can
-- be collected is a *setting*, and settings are an admin's — so the Settings
-- page has to know whether Google Drive is connected without being able to see
-- the connection.
--
-- This answers exactly that and nothing else: one boolean, for one kind, for
-- an organization the caller already administers. It reveals no credential, no
-- account name, and no configuration — only whether the thing would work.
--
-- Without it the selfie options would have to be owner-only too, which would
-- put "should we ask visitors for a photo" in the same drawer as the service
-- account's private key. Those are not the same decision.
--
-- Additive and idempotent.
-- ============================================================================

create or replace function public.integration_ready(p_org uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select i.enabled
       and case p_kind
             -- Drive needs both halves of a service account before an upload
             -- can succeed: the address it acts as, and the key it signs with.
             when 'google_drive' then
               i.secret_id is not null
               and coalesce(i.config ->> 'sa_client_email', '') <> ''
             else true
           end
    from public.integrations i
    where i.org_id = p_org
      and i.kind = p_kind
      -- Per row rather than trusted to the caller, and admin rather than owner:
      -- this is the one fact about an integration a non-owner may have.
      and public.auth_is_org_admin(p_org)
  ), false)
$$;

comment on function public.integration_ready(uuid, text) is
  'Whether one integration is connected and usable for an organization. A '
  'single boolean for an admin of that org — never the credential or the '
  'configuration behind it.';

grant execute on function public.integration_ready(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice. Pasted here there is no auth.uid(), so this
-- confirms the function compiles and refuses an anonymous caller — false is
-- the correct answer to "may I", not an error.
select public.integration_ready(
  (select id from public.organizations order by created_at limit 1), 'google_drive'
) as ready_for_anonymous_caller;
