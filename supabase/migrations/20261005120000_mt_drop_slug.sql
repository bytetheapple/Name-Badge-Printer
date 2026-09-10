-- The slug goes.
--
-- It was put in on day one as a URL-friendly identifier for per-organization
-- addresses that were never built. Customers never saw it. Its two remaining
-- jobs were being typed in when an organization was created, for nothing to
-- use afterwards, and being typed again to confirm a deletion -- which the
-- name does at least as well. A field the operator has to invent and then
-- remember, for nothing.
--
-- With it goes the one uniqueness the table had. Two organizations really can
-- both be called Temple Beth El, which is true in the world and is what
-- internal_name is for. The deletion confirmation therefore asks for the
-- more specific of the two names when there is one.

-- 1. Creating an organization takes only a name.
drop function if exists public.create_organization(text, text);
create function public.create_organization(p_name text)
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
  if p_name is null or btrim(p_name) = '' then
    raise exception 'the organization needs a name';
  end if;

  insert into public.organizations (name)
  values (btrim(p_name))
  returning id into v_org;

  -- No membership for the creator. An operator reaches this organization
  -- because they are an operator; making them a member as well would put them
  -- on the customer's own Members tab, which is the thing the split exists to
  -- prevent.

  -- The three per-org singletons. Their absence does not fail loudly -- it
  -- surfaces later as a kiosk with no settings -- so they are created here
  -- rather than left to whoever remembers.
  insert into public.printer_config (org_id) values (v_org);
  insert into public.printer_status (org_id) values (v_org);
  insert into public.app_settings   (org_id) values (v_org);

  return v_org;
end;
$$;

revoke all on function public.create_organization(text) from public;
grant execute on function public.create_organization(text) to authenticated;

-- 2. Deleting one is confirmed against the name that tells it apart.
drop function if exists public.delete_organization(uuid, text);
create function public.delete_organization(p_org uuid, p_confirm_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org    public.organizations%rowtype;
  v_expect text;
  v_gone   jsonb;
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'only the Guest Badges team can delete an organization'
      using errcode = 'insufficient_privilege';
  end if;
  if not coalesce(public.is_platform_owner(), false) then
    raise exception 'deleting an organization is reserved for an owner; suspending is not'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_org from public.organizations where id = p_org;
  if not found then
    raise exception 'no such organization';
  end if;

  -- The internal name when there is one, because that is the name that
  -- distinguishes this organization from another with the same public name.
  -- Typed by hand, and compared to the row we actually found rather than to
  -- anything the caller supplied alongside it.
  v_expect := coalesce(nullif(btrim(v_org.internal_name), ''), v_org.name);
  if btrim(coalesce(p_confirm_name, '')) <> v_expect then
    raise exception 'to delete this organization, type its name exactly: %', v_expect;
  end if;

  -- Counted before the delete, and returned, so the answer to "what did I just
  -- destroy?" exists after the fact rather than only in the confirmation.
  select jsonb_build_object(
    'name',          v_org.name,
    'internal_name', v_org.internal_name,
    'printers',      (select count(*) from public.printers where org_id = p_org),
    'entries',       (select count(*) from public.form_entries where org_id = p_org),
    'print_jobs',    (select count(*) from public.print_jobs where org_id = p_org),
    'members',       (select count(*) from public.memberships where org_id = p_org),
    'bridges',       (select count(*) from public.bridge_tokens where org_id = p_org),
    'api_keys',      (select count(*) from public.api_keys where org_id = p_org)
  ) into v_gone;

  -- Everything that carries org_id cascades, and the two Vault-cleanup
  -- triggers (integrations, provisioning_sessions) fire on the cascaded rows,
  -- so no decrypted credential is left behind. The last-owner guard already
  -- stands down when the organization itself is going away.
  --
  -- Two things deliberately survive: the users, because a person may belong to
  -- other organizations and deleting the account is a separate decision; and
  -- uploaded images in storage, which are content-addressed and may be shared
  -- with another org's identical upload.
  delete from public.organizations where id = p_org;

  return v_gone;
end;
$$;

revoke all on function public.delete_organization(uuid, text) from public;
grant execute on function public.delete_organization(uuid, text) to authenticated;

-- 3. The overview no longer carries it.
drop function if exists public.platform_overview();
create function public.platform_overview()
returns table (
  org_id              uuid,
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
    o.id, o.name, o.internal_name, o.address, o.notes,
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

grant execute on function public.platform_overview() to authenticated, service_role;

-- 4. And the column itself. Last, so everything that read it has already
--    stopped.
alter table public.organizations drop column if exists slug;
