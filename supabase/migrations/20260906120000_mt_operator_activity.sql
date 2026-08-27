-- ============================================================================
-- Operator activity
--
-- The log table already exists and membership changes already write to it from
-- the Edge Function. This adds the platform side: creating, suspending and
-- deleting organizations, issuing and revoking print-server credentials,
-- allocating hardware, moving the fleet's release, and every change to who is
-- an operator.
--
-- Triggers rather than instrumenting each function. Two reasons, and the
-- second matters more than the first:
--
--   * The functions would all have to be rewritten to add one line each, and a
--     rewritten function is a chance to change something else by accident.
--   * A trigger catches the SQL editor too. Half of these actions have been
--     performed by hand at least once during this build, and an audit trail
--     that records only what went through the app is one that quietly omits
--     exactly the events most worth having.
--
-- Rows for a tenant carry its org_id and its owner can read them. Rows about
-- the platform — operators, releases, a deleted organization — carry null and
-- only operators can. Deleting an organization must log with null: org_id
-- cascades, so a row blaming the deletion on the deleted org would delete
-- itself.
--
-- Additive and idempotent.
-- ============================================================================

-- The one writer. SECURITY DEFINER and owned by postgres, so it writes past
-- the table's own RLS — which grants nobody INSERT — and is revoked from the
-- Data API roles so that path cannot be used to forge an entry.
create or replace function public.log_activity(
  p_org     uuid,
  p_action  text,
  p_subject text,
  p_detail  jsonb default '{}'::jsonb,
  --: Who to blame when auth.uid() cannot say. An Edge Function acting with the
  --: service_role has no JWT of its own, so without this every operator added
  --: through the app would be recorded as having been added by nobody.
  p_actor   uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid   uuid := coalesce(auth.uid(), p_actor);
  v_email text;
begin
  -- Null when the action came from the SQL editor or a service_role job. That
  -- is worth recording as "nobody signed in" rather than not recording at all.
  select u.email::text into v_email from auth.users u where u.id = v_uid;
  insert into public.activity_log (org_id, actor_id, actor_email, action, subject, detail)
  values (p_org, v_uid, v_email, p_action, p_subject, coalesce(p_detail, '{}'::jsonb));
end;
$$;

revoke all on function public.log_activity(uuid, text, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.log_activity(uuid, text, text, jsonb, uuid) to service_role;

-- ------------------------------------------------------- organizations
create or replace function public.log_organization_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_activity(new.id, 'org.create', new.name,
      jsonb_build_object('slug', new.slug));
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      perform public.log_activity(new.id, 'org.status', new.name,
        jsonb_build_object('from', old.status, 'to', new.status));
    end if;
    if new.custom_integrations is distinct from old.custom_integrations then
      perform public.log_activity(new.id, 'org.custom_integrations', new.name,
        jsonb_build_object('enabled', new.custom_integrations));
    end if;
    if new.name is distinct from old.name then
      perform public.log_activity(new.id, 'org.rename', new.name,
        jsonb_build_object('from', old.name));
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists organizations_activity on public.organizations;
create trigger organizations_activity
  after insert or update on public.organizations
  for each row execute function public.log_organization_activity();

-- BEFORE, and with a null org_id: the row must be written while the
-- organization still exists to be described, and must not be owned by it or
-- the cascade takes the record of its own deletion with it.
create or replace function public.log_organization_deleted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.log_activity(null, 'org.delete', old.name,
    jsonb_build_object(
      'slug',    old.slug,
      'members', (select count(*) from public.memberships where org_id = old.id),
      'entries', (select count(*) from public.form_entries where org_id = old.id)));
  return old;
end;
$$;

drop trigger if exists organizations_delete_activity on public.organizations;
create trigger organizations_delete_activity
  before delete on public.organizations
  for each row execute function public.log_organization_deleted();

-- ------------------------------------------------- print-server credentials
-- Only when a person did it. Devices rotate their own credentials on a ninety
-- day cycle through the service_role, and recording thousands of those would
-- bury the handful of times someone issued or revoked one by hand.
create or replace function public.log_bridge_token_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform public.log_activity(new.org_id, 'bridge.issue', new.name,
      jsonb_build_object('prefix', new.token_prefix));
  elsif tg_op = 'UPDATE' and new.revoked_at is not null and old.revoked_at is null then
    perform public.log_activity(new.org_id, 'bridge.revoke', new.name,
      jsonb_build_object('prefix', new.token_prefix));
  end if;
  return null;
end;
$$;

drop trigger if exists bridge_tokens_activity on public.bridge_tokens;
create trigger bridge_tokens_activity
  after insert or update on public.bridge_tokens
  for each row execute function public.log_bridge_token_activity();

-- --------------------------------------------------------------- operators
-- Null org_id: who runs the service is platform business, and no customer's
-- owner should see the shape of the team that supports them.
create or replace function public.log_operator_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  select u.email::text into v_email
  from auth.users u
  where u.id = coalesce(new.user_id, old.user_id);

  -- The DELETE arm runs on a BEFORE trigger, where the return value decides
  -- whether the row actually goes. Returning null there cancels the delete —
  -- silently, with the statement reporting zero rows — so removing an operator
  -- would appear to work and change nothing.
  if tg_op = 'DELETE' then
    perform public.log_activity(null, 'operator.remove', v_email,
      jsonb_build_object('role', old.role));
    return old;
  end if;

  if tg_op = 'INSERT' then
    perform public.log_activity(null, 'operator.add', v_email,
      jsonb_build_object('role', new.role), new.added_by);
  elsif new.role is distinct from old.role then
    perform public.log_activity(null, 'operator.role', v_email,
      jsonb_build_object('from', old.role, 'to', new.role));
  end if;
  return null;
end;
$$;

drop trigger if exists platform_admins_activity on public.platform_admins;
create trigger platform_admins_activity
  after insert or update on public.platform_admins
  for each row execute function public.log_operator_activity();

-- Separate, and BEFORE, so the email can still be resolved and so the row is
-- written whether or not the account itself is going away afterwards.
drop trigger if exists platform_admins_delete_activity on public.platform_admins;
create trigger platform_admins_delete_activity
  before delete on public.platform_admins
  for each row execute function public.log_operator_activity();

-- ----------------------------------------------------------------- hardware
create or replace function public.log_pi_device_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.log_activity(new.org_id, 'device.allocate', new.serial,
    jsonb_build_object('customer', new.customer));
  return null;
end;
$$;

drop trigger if exists pi_devices_activity on public.pi_devices;
create trigger pi_devices_activity
  after insert on public.pi_devices
  for each row execute function public.log_pi_device_activity();

-- ------------------------------------------------------------- the release
-- Fleet-wide and platform-level: one row here moves every print server that is
-- not pinned to something else.
create or replace function public.log_bridge_release_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.ref is distinct from old.ref then
    perform public.log_activity(null, 'release.set', new.ref,
      jsonb_build_object('from', old.ref, 'to', new.ref));
  end if;
  return null;
end;
$$;

drop trigger if exists bridge_release_activity on public.bridge_release;
create trigger bridge_release_activity
  after update on public.bridge_release
  for each row execute function public.log_bridge_release_activity();

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice. Six triggers, and log_activity must not be
-- callable by anon or authenticated — that is what stops a forged entry.
select
  (select count(*) from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and t.tgname like '%_activity')                     as activity_triggers,
  (select coalesce(pg_catalog.array_to_string(p.proacl, ' | '), '(owner only)')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'log_activity')                   as log_activity_grants,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'log_activity')                   as log_activity_overloads;
