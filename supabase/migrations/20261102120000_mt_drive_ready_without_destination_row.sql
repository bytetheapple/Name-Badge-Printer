-- ============================================================================
-- Photographs are ready when the org can write to its Drive at all — even
-- before a photographs destination row exists.
--
-- The previous version answered integration_ready(org, 'google_drive') from a
-- CASE *inside* a query that already required a google_drive row to exist. The
-- connected-account fallback therefore only helped a google_drive row that
-- lacked its own service-account key; an org that had connected Google but had
-- no google_drive destination yet still read as not ready.
--
-- That is a deadlock, and it is exactly what an owner hit enabling selfies:
--   • integration_ready('google_drive') is false (no destination row yet),
--   • so Settings never calls google-provision, which is the only thing that
--     makes the destination row,
--   • so the row is never made, so it stays false — and the page sends the
--     owner back through the Google consent screen on a loop, enabling nothing,
--     even though a connection test shows a valid token with drive.file access.
--
-- Fix: decide readiness without requiring the destination row. 'google_drive'
-- is ready when the org has either a google_drive destination with its own
-- service-account key (the original path), OR a connected google_oauth account
-- — which holds the credential centrally and is granted drive.file when it is
-- connected (see google-oauth-begin SCOPES). google-provision then creates the
-- destination row on the next click, now that the page lets it get that far.
--
-- Additive: replaces the function body only.
-- ============================================================================

create or replace function public.integration_ready(p_org uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.auth_is_org_admin(p_org)
     and case p_kind
           when 'google_drive' then
             -- Its own service account, the original path …
             exists (
               select 1
                 from public.integrations i
                where i.org_id = p_org
                  and i.kind = 'google_drive'
                  and i.enabled
                  and i.secret_id is not null
                  and coalesce(i.config ->> 'sa_client_email', '') <> ''
             )
             -- … or the organization's connected Google account, which can
             -- write to Drive centrally with no destination row of its own.
             or exists (
               select 1
                 from public.integrations o
                where o.org_id = p_org
                  and o.kind = 'google_oauth'
                  and o.enabled
                  and o.secret_id is not null
             )
           else
             -- Every other kind: ready when an enabled row of it exists, which
             -- is what the original function answered.
             exists (
               select 1
                 from public.integrations i
                where i.org_id = p_org
                  and i.kind = p_kind
                  and i.enabled
             )
         end
$$;

-- Unchanged from the original: an admin asking about their own organization.
revoke all on function public.integration_ready(uuid, text) from public, anon;
grant execute on function public.integration_ready(uuid, text) to authenticated, service_role;

-- Verify: which orgs can now take photographs. (integration_ready itself gates
-- on auth_is_org_admin, which is false in the SQL editor with no logged-in user,
-- so check the underlying capability directly here instead.)
select o.name,
       exists (
         select 1 from public.integrations x
          where x.org_id = o.id and x.kind = 'google_oauth'
            and x.enabled and x.secret_id is not null
       )
       or exists (
         select 1 from public.integrations x
          where x.org_id = o.id and x.kind = 'google_drive' and x.enabled
            and x.secret_id is not null
            and coalesce(x.config ->> 'sa_client_email', '') <> ''
       ) as drive_capable
  from public.organizations o
 order by o.name;
