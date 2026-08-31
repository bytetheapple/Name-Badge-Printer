-- ============================================================================
-- The destination list, for someone who may not read the destinations
--
-- Integrations belong to the owner — they hold credentials and decide where a
-- congregation's visitor data goes. Printers belong to an admin. But "does
-- this kiosk feed that destination" is a printer setting, so the Printers tab
-- has to list the destinations without being able to read them.
--
-- Same shape as integration_ready: the narrowest fact that makes the screen
-- work. Names and switches, never config and never a credential. Without it
-- the per-printer panel would be empty for exactly the person who manages
-- printers, or the whole Printers tab would have to become owner-only.
--
-- Additive and idempotent.
-- ============================================================================

create or replace function public.integrations_brief(p_org uuid)
returns table (
  id              uuid,
  kind            text,
  name            text,
  enabled         boolean,
  default_enabled boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select i.id, i.kind, i.name, i.enabled, i.default_enabled
  from public.integrations i
  where i.org_id = p_org
    -- Per row rather than trusted to the caller, as everywhere else.
    and public.auth_is_org_admin(p_org)
  order by i.kind, i.name;
$$;

comment on function public.integrations_brief(uuid) is
  'Every integration an organization has, by name and switch only. For the '
  'Printers tab, which is an admin''s while integrations are an owner''s. '
  'Never returns config or a credential.';

grant execute on function public.integrations_brief(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice. No auth.uid() here, so an empty result is the
-- correct answer rather than a problem.
select count(*) as visible_to_anonymous_caller
from public.integrations_brief((select id from public.organizations order by created_at limit 1));
