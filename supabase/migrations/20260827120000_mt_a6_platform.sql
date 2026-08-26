-- ============================================================================
-- Phase A6 — creating a tenant, and suspending one
--
-- Two things the platform team could not do at all, and one that was pretending
-- it could.
--
--   * There is no insert policy on organizations, so onboarding a customer
--     meant hand-written SQL — and getting the three per-org singleton rows
--     right from memory each time.
--   * `organizations.status` has existed since A1 with 'active | suspended' and
--     nothing anywhere reads it. Suspending a customer changed nothing.
--
-- Additive and idempotent.
-- ============================================================================

-- ------------------------------------------------------- creating an org
-- SECURITY DEFINER because the caller is, by definition, not yet a member of
-- the organization they are creating — no RLS policy can express that.
--
-- The creator becomes its owner. That is a deliberate onboarding choice: the
-- printers and integrations get set up before the customer ever signs in, and
-- the account is handed over afterwards. It leaves the operator attached to
-- every tenant until they step down, which the console surfaces rather than
-- leaves to memory.
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
    raise exception 'only the Name Badge Kiosk team can create an organization'
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

  insert into public.memberships (org_id, user_id, role) values (v_org, v_uid, 'owner');

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
  'Create a tenant and make the caller its owner. Platform admins only. Also '
  'creates the printer_config, printer_status and app_settings singletons.';

grant execute on function public.create_organization(text, text) to authenticated, service_role;

-- --------------------------------------------------- suspension with teeth
-- Read by the kiosk and bridge paths. A suspended organization stops taking
-- sign-ins and stops being handed print jobs; nothing is deleted and nothing
-- is lost, and turning it back on restores service immediately.
create or replace function public.org_is_active(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select status = 'active' from public.organizations where id = p_org), false);
$$;

-- Server-only: it takes an org id and is used to decide whether to serve
-- someone. Both revokes are needed — a new function is EXECUTE-to-PUBLIC by
-- default and this project also grants the Data API roles EXECUTE by name.
revoke all on function public.org_is_active(uuid) from public, anon, authenticated;
grant execute on function public.org_is_active(uuid) to service_role;

-- ------------------------------------------------------------- the guard
-- A2 gave owners `for update` on their own organizations row so they could
-- rename it, and that policy is column-blind. The custom_integrations guard
-- already exists for exactly this reason; `status` needs the same treatment,
-- or a suspended customer could simply set themselves back to active.
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
    if new.status is distinct from old.status then
      raise exception 'an organization''s status is set by the Name Badge Kiosk team'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

-- ------------------------------------------------- the cross-tenant view
-- One row per organization with enough to answer "is this customer all right?"
-- without switching into their account. Platform admins only.
create or replace function public.platform_overview()
returns table (
  org_id              uuid,
  slug                text,
  name                text,
  status              text,
  custom_integrations boolean,
  created_at          timestamptz,
  members             bigint,
  printers            bigint,
  entries_30d         bigint,
  bridge_last_seen    timestamptz,
  live_bridges        bigint,
  --: Whether a platform admin is still a member. An onboarding that was never
  --: handed over looks exactly like one that was, without this.
  operator_attached   boolean
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
      where b.org_id = o.id and b.revoked_at is null),
    exists (
      select 1 from public.memberships m
      join public.platform_admins pa on pa.user_id = m.user_id
      where m.org_id = o.id
    )
  from public.organizations o
  where public.is_platform_admin()
  order by o.created_at;
$$;

comment on function public.platform_overview() is
  'Every organization with enough health to triage from. Returns nothing to a '
  'caller who is not a platform admin — the check is in the WHERE clause, so '
  'it is applied per row rather than trusted to the caller.';

grant execute on function public.platform_overview() to authenticated, service_role;

-- Verify: org_is_active must not list anon or authenticated.
select p.proname,
       coalesce(pg_catalog.array_to_string(p.proacl, ' | '), '(owner only)') as grants
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_organization', 'org_is_active', 'platform_overview')
order by p.proname;
