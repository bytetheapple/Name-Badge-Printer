-- ============================================================================
-- Custom integrations — a capability we grant, not one an org grants itself
--
-- Pushing sign-ins into a congregation's own systems (a ShulCloud welcome form,
-- a Google Form, a spreadsheet) means learning that system's field names and
-- keeping up when they change. It is bespoke work, sold and set up by hand.
--
-- So the settings for it are only shown to an organization we have actually
-- built something for. Everyone else is told the option exists and who to ask.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.organizations
  add column if not exists custom_integrations boolean not null default false;

comment on column public.organizations.custom_integrations is
  'Whether this org may configure bespoke sync targets (Google Form, '
  'ShulCloud). Set by a platform admin after the work is done — an org cannot '
  'turn it on for itself; see enforce_custom_integrations_grant().';

-- The org that already has both configured. Written as a slug match rather
-- than "the only org", so re-running this after a second tenant exists still
-- does the right thing.
update public.organizations
   set custom_integrations = true
 where slug = 'shir-hadash';

-- --------------------------------------------------------------- the guard
-- A2 gave owners `for update` on their own organizations row so they could
-- rename it. That policy is column-blind, so without this an owner could flip
-- their own flag and help themselves to a paid capability.
--
-- RLS cannot express "every column but this one", so the check is a trigger.
-- service_role is allowed through (auth.uid() is null) for the Edge Functions
-- and for whatever super-admin tooling A6 brings.
create or replace function public.enforce_custom_integrations_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.custom_integrations is distinct from old.custom_integrations
     and auth.uid() is not null
     and not coalesce(public.is_platform_admin(), false) then
    raise exception
      'custom integrations are enabled by the Name Badge Kiosk team; contact support'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_custom_integrations_guard on public.organizations;
create trigger organizations_custom_integrations_guard
  before update on public.organizations
  for each row execute function public.enforce_custom_integrations_grant();
