-- What the operator knows about a customer that the customer's guests do not.
--
-- `name` is the customer's name as the world sees it: it prints on badges,
-- heads the sign-in form, and is on the lobby sign. That made it the wrong
-- place to disambiguate. "Temple Beth El Santa Cruz" was convenient on the
-- Operations page and wrong on every badge, because the congregation is in
-- Aptos and is simply called Temple Beth El -- and there are a dozen Shir
-- Hadashes. So the operator's handle, the address and any notes get columns
-- of their own, and `name` goes back to meaning what it says.
alter table public.organizations
  add column if not exists internal_name text,
  add column if not exists address       text,
  add column if not exists notes         text;

comment on column public.organizations.name is
  'The customer''s name as their guests see it: badges, the sign-in form, the lobby sign.';
comment on column public.organizations.internal_name is
  'The operator''s handle for telling similarly named customers apart. Never shown to the customer or their guests.';
comment on column public.organizations.address is
  'Where the customer is. Operations only.';
comment on column public.organizations.notes is
  'Free text for the operator. Operations only.';

-- The operator's handle and notes are the operator's. An owner may rename
-- their organization -- that policy is column-blind, which is why this guard
-- exists -- but must not be able to edit what we call them internally or what
-- we have written down about them. Same trigger as the entitlements, for the
-- same reason: one list of what a customer may not set is easier to audit
-- than several.
create or replace function public.enforce_custom_integrations_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not coalesce(public.is_platform_admin(), false) then
    if new.custom_integrations is distinct from old.custom_integrations then
      raise exception
        'custom integrations are enabled by the Name Badge Kiosk team; contact support'
        using errcode = 'insufficient_privilege';
    end if;
    if new.events_enabled is distinct from old.events_enabled then
      raise exception
        'events are enabled by the Name Badge Kiosk team; contact support'
        using errcode = 'insufficient_privilege';
    end if;
    if new.status is distinct from old.status then
      raise exception 'an organization''s status is set by the Name Badge Kiosk team'
        using errcode = 'insufficient_privilege';
    end if;
    if new.internal_name is distinct from old.internal_name
       or new.notes is distinct from old.notes then
      raise exception 'those fields belong to the Name Badge Kiosk team'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

drop function if exists public.platform_overview();
create function public.platform_overview()
returns table (
  org_id              uuid,
  slug                text,
  name                text,
  internal_name       text,
  address             text,
  notes               text,
  status              text,
  custom_integrations boolean,
  events_enabled      boolean,
  created_at          timestamptz,
  members             bigint,
  printers            bigint,
  entries_30d         bigint,
  bridge_last_seen    timestamptz,
  live_bridges        bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id, o.slug, o.name, o.internal_name, o.address, o.notes,
    o.status, o.custom_integrations, o.events_enabled, o.created_at,
    (select count(*) from public.memberships m where m.org_id = o.id),
    (select count(*) from public.printers p where p.org_id = o.id),
    (select count(*) from public.form_entries e
      where e.org_id = o.id and e.created_at > now() - interval '30 days'),
    (select ps.bridge_last_seen from public.printer_status ps where ps.org_id = o.id),
    (select count(*) from public.bridge_tokens b
      where b.org_id = o.id and b.revoked_at is null)
  from public.organizations o
  where public.is_platform_admin()
  order by coalesce(o.internal_name, o.name), o.created_at;
$$;

comment on function public.platform_overview() is
  'Every organization with enough health to triage from. Returns nothing to a '
  'caller who is not a platform admin — the check is in the WHERE clause, so '
  'it is applied per row rather than trusted to the caller.';

grant execute on function public.platform_overview() to authenticated, service_role;
