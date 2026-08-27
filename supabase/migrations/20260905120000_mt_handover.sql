-- ============================================================================
-- Handover
--
-- create_organization() made its creator the owner. That was the onboarding
-- story before operators could reach a tenant they did not belong to: set the
-- congregation up as its owner, then hand the account over and step down. The
-- stepping down is the part people forget, which is why platform_overview()
-- grew an `operator_attached` column whose entire job was catching the ones
-- nobody stepped down from.
--
-- Operators now reach every organization on operator standing, so the
-- membership was the last thing making them a tenant's member — and the
-- failure it was guarding against no longer exists. A new organization simply
-- has no members until its first owner is invited.
--
-- The new failure mode is different and better: an organization with zero
-- members is one that was built and never handed to anybody. That is already
-- visible in the `members` count the console shows, so `operator_attached`
-- goes rather than being reinterpreted.
--
-- Additive except for the dropped column, which requires the function to be
-- dropped and recreated — a returns-table signature cannot be changed in place.
-- ============================================================================

-- ----------------------------------------------------- creating a tenant
-- SECURITY DEFINER because the caller is, by definition, not a member of the
-- organization they are creating — and now never becomes one.
create or replace function public.create_organization(p_slug text, p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_uid uuid := auth.uid();
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'only the Guest Badges team can create an organization'
      using errcode = 'insufficient_privilege';
  end if;
  if v_uid is null then
    raise exception 'create_organization must be called by a signed-in user';
  end if;

  if p_slug is null or btrim(p_slug) = '' then
    raise exception 'the organization needs a slug';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'the organization needs a name';
  end if;
  -- The slug appears in support conversations and in URLs; keep it to
  -- something that survives being read aloud and typed back.
  if btrim(p_slug) !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'the slug may contain only lowercase letters, numbers and hyphens';
  end if;
  if exists (select 1 from public.organizations where slug = btrim(p_slug)) then
    raise exception 'an organization with the slug % already exists', btrim(p_slug);
  end if;

  insert into public.organizations (slug, name)
  values (btrim(p_slug), btrim(p_name))
  returning id into v_org;

  -- No membership for the creator. An operator reaches this organization
  -- because they are an operator; making them a member as well would put them
  -- on the customer's own Members tab, which is the thing the split exists to
  -- prevent.

  -- The three per-org singletons. Their absence does not fail loudly — it
  -- surfaces later as a kiosk with no settings — so they are created here
  -- rather than left to whoever remembers.
  insert into public.printer_config (org_id) values (v_org);
  insert into public.printer_status (org_id) values (v_org);
  insert into public.app_settings   (org_id) values (v_org);

  return v_org;
end;
$$;

comment on function public.create_organization(text, text) is
  'Create a tenant. Platform admins only. The creator does not become a member '
  'of it — operators reach an organization on operator standing. Also creates '
  'the printer_config, printer_status and app_settings singletons.';

grant execute on function public.create_organization(text, text) to authenticated, service_role;

-- ------------------------------------------------- the cross-tenant view
-- Unchanged except that operator_attached is gone. A returns-table signature
-- cannot be altered in place, so the function is dropped first.
drop function if exists public.platform_overview();

create function public.platform_overview()
returns table (
  org_id              uuid,
  slug                text,
  name                text,
  status              text,
  custom_integrations boolean,
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
    o.id, o.slug, o.name, o.status, o.custom_integrations, o.created_at,
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

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice. Any organization with no members has not been
-- handed over yet; any operator still holding a membership is a leftover from
-- before this migration and worth knowing about.
select
  (select count(*) from public.organizations o
    where not exists (select 1 from public.memberships m where m.org_id = o.id))  as orgs_with_no_members,
  (select count(*) from public.memberships m
    join public.platform_admins pa on pa.user_id = m.user_id)                     as operator_memberships;
