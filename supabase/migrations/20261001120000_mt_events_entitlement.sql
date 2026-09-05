-- Events are a paid feature, switched on per customer by the platform team.
--
-- Same shape as custom_integrations, and for the same reason: an organization
-- owner has `for update` on their own row so they can rename it, and that
-- policy is column-blind. Without a guard, a customer could bill themselves
-- into a feature by ticking a box in a browser console.
--
-- Turning it off does not destroy anything. Existing event integrations stay
-- in the admin, marked unavailable, and stop accepting registrations; turning
-- it back on restores them intact. A billing change should not delete a
-- customer's data, and an operator switching this off in a hurry should not
-- be able to.
alter table public.organizations
  add column if not exists events_enabled boolean not null default false;

comment on column public.organizations.events_enabled is
  'Whether this organization may create and run Event integrations. Set by the '
  'platform team only; see enforce_custom_integrations_grant().';

-- The existing guard already covers custom_integrations and status. Extended
-- rather than duplicated: one trigger listing every column a customer may not
-- set itself is easier to audit than three that each cover one.
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
  end if;
  return new;
end;
$$;

-- Carried on the overview so the Operations table can show and set it beside
-- the other entitlement, rather than needing a second read per row.
drop function if exists public.platform_overview();
create function public.platform_overview()
returns table (
  org_id              uuid,
  slug                text,
  name                text,
  status              text,
  custom_integrations boolean,
  events_enabled      boolean,
  created_at          timestamptz,
  --: Zero means built and never handed to anybody — the replacement for the
  --: question operator_attached used to answer.
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
    o.id, o.slug, o.name, o.status, o.custom_integrations, o.events_enabled,
    o.created_at,
    (select count(*) from public.memberships m where m.org_id = o.id),
    (select count(*) from public.printers p where p.org_id = o.id),
    (select count(*) from public.form_entries e
      where e.org_id = o.id and e.created_at > now() - interval '30 days'),
    (select ps.bridge_last_seen from public.printer_status ps where ps.org_id = o.id),
    (select count(*) from public.bridge_tokens b
      where b.org_id = o.id and b.revoked_at is null)
  from public.organizations o
  where public.is_platform_admin()
  order by o.created_at;
$$;

comment on function public.platform_overview() is
  'Every organization with enough health to triage from. Returns nothing to a '
  'caller who is not a platform admin — the check is in the WHERE clause, so '
  'it is applied per row rather than trusted to the caller.';

grant execute on function public.platform_overview() to authenticated, service_role;

-- An organization reads its own entitlements to decide what to offer; the
-- existing "org read organizations" policy already allows that, and this
-- column carries nothing sensitive.
