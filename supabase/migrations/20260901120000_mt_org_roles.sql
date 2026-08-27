-- ============================================================================
-- The org role matrix, restated
--
-- The old line between owner and admin was "an admin may manage staff but not
-- other admins" — a rule you have to reason about every time you use it, and
-- one nobody could state from memory. The new line is a sentence:
--
--     owner manages people, admin manages equipment, staff runs the desk.
--
-- Concretely:
--   owner  — everything an admin can do, plus members, integrations and API
--            keys. The things that decide who or what gets in.
--   admin  — printers, their configuration, and the org's settings. The
--            equipment.
--   staff  — reads everything above and prints. Changes nothing.
--
-- Three shifts from what was there before:
--   * staff could not see printers, their config or the org settings at all;
--     now they can read all three. A greeter should be able to answer "what is
--     this thing set to" without being able to change it.
--   * admin could add and remove staff; that is now owner-only. Access is
--     granted by the people who own the account, not by whoever runs the desk
--     equipment.
--   * integrations and API keys move from admin to owner. Both hand out a way
--     in — an API key lets an outside system print into the org indefinitely —
--     so they belong with membership rather than with printers.
--
-- Staff keep INSERT on print_jobs, which is untouched here and load-bearing:
-- reprinting a badge that did not come out is the entire job at a sign-in
-- table.
--
-- Additive and idempotent.
-- ============================================================================

-- ------------------------------------------- staff may read the equipment
-- Read only. Every insert/update/delete on these tables stays with admin.
drop policy if exists "org read printers" on public.printers;
create policy "org read printers" on public.printers
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

drop policy if exists "org read printer_config" on public.printer_config;
create policy "org read printer_config" on public.printer_config
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

drop policy if exists "org read app_settings" on public.app_settings;
create policy "org read app_settings" on public.app_settings
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

-- --------------------------------------------- members are the owner's job
-- Reading the member list stays with the whole org: knowing who else is here
-- is not a privilege. Changing it is.
drop policy if exists "manage org memberships insert" on public.memberships;
create policy "manage org memberships insert" on public.memberships
  for insert to authenticated
  with check (public.auth_is_org_owner(org_id));

drop policy if exists "manage org memberships update" on public.memberships;
create policy "manage org memberships update" on public.memberships
  for update to authenticated
  using (public.auth_is_org_owner(org_id))
  with check (public.auth_is_org_owner(org_id));

drop policy if exists "manage org memberships delete" on public.memberships;
create policy "manage org memberships delete" on public.memberships
  for delete to authenticated
  using (public.auth_is_org_owner(org_id));

-- ------------------------------------------ integrations are the owner's job
-- Complicated, rarely changed, strategic — and they hold the credentials that
-- let this deployment act as the organization somewhere else.
drop policy if exists "org read integrations" on public.integrations;
create policy "org read integrations" on public.integrations
  for select to authenticated
  using (public.auth_is_org_owner(org_id));

drop policy if exists "org insert integrations" on public.integrations;
create policy "org insert integrations" on public.integrations
  for insert to authenticated
  with check (public.auth_is_org_owner(org_id));

drop policy if exists "org update integrations" on public.integrations;
create policy "org update integrations" on public.integrations
  for update to authenticated
  using (public.auth_is_org_owner(org_id))
  with check (public.auth_is_org_owner(org_id));

drop policy if exists "org delete integrations" on public.integrations;
create policy "org delete integrations" on public.integrations
  for delete to authenticated
  using (public.auth_is_org_owner(org_id));

-- ---------------------------------------------- API keys are the owner's job
-- A key is a standing invitation for an outside system to print into this
-- organization. That is an access decision wearing a configuration costume.
drop policy if exists "org read api_keys" on public.api_keys;
create policy "org read api_keys" on public.api_keys
  for select to authenticated
  using (public.auth_is_org_owner(org_id));

drop policy if exists "org insert api_keys" on public.api_keys;
create policy "org insert api_keys" on public.api_keys
  for insert to authenticated
  with check (public.auth_is_org_owner(org_id));

drop policy if exists "org update api_keys" on public.api_keys;
create policy "org update api_keys" on public.api_keys
  for update to authenticated
  using (public.auth_is_org_owner(org_id))
  with check (public.auth_is_org_owner(org_id));

drop policy if exists "org delete api_keys" on public.api_keys;
create policy "org delete api_keys" on public.api_keys
  for delete to authenticated
  using (public.auth_is_org_owner(org_id));

-- ------------------------------- the credential functions, same boundary
-- The three Vault helpers are SECURITY DEFINER and were gated on
-- auth_is_org_admin, so moving the integrations *table* to the owner is not
-- enough on its own: an admin could still write and clear a credential through
-- these, which is the whole of what the table was protecting. A permission
-- moved in one place and left in another is not moved.
create or replace function public.set_integration_secret(
  p_org uuid,
  p_kind text,
  p_secret text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_name   text := format('org:%s:%s', p_org, p_kind);
  v_row    public.integrations%rowtype;
  v_secret uuid;
begin
  if not coalesce(public.auth_is_org_owner(p_org), false) then
    raise exception 'integrations are managed by an owner of this organization'
      using errcode = 'insufficient_privilege';
  end if;
  if p_secret is null or length(btrim(p_secret)) = 0 then
    raise exception 'the secret is empty';
  end if;

  insert into public.integrations (org_id, kind)
  values (p_org, p_kind)
  on conflict (org_id, kind) do nothing;

  select * into v_row from public.integrations where org_id = p_org and kind = p_kind;

  if v_row.secret_id is null then
    v_secret := vault.create_secret(p_secret, v_name, 'Name Badge Kiosk integration credential');
    update public.integrations set secret_id = v_secret where id = v_row.id;
  else
    perform vault.update_secret(v_row.secret_id, p_secret);
  end if;
end;
$$;

create or replace function public.clear_integration_secret(p_org uuid, p_kind text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_secret uuid;
begin
  if not coalesce(public.auth_is_org_owner(p_org), false) then
    raise exception 'integrations are managed by an owner of this organization'
      using errcode = 'insufficient_privilege';
  end if;

  select secret_id into v_secret from public.integrations where org_id = p_org and kind = p_kind;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
    update public.integrations set secret_id = null where org_id = p_org and kind = p_kind;
  end if;
end;
$$;

-- Whether a credential is set, without revealing it — so the UI can show
-- "configured" rather than an empty box that looks unsaved.
create or replace function public.integration_has_secret(p_org uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select secret_id is not null
       from public.integrations
      where org_id = p_org and kind = p_kind and public.auth_is_org_owner(p_org)),
    false)
$$;

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice: the Supabase SQL editor discards notices.
-- Every policy below should name the role the matrix says it should.
select tablename, policyname, cmd,
       case
         when coalesce(qual, with_check) like '%auth_is_org_owner%' then 'owner'
         when coalesce(qual, with_check) like '%auth_is_org_admin%' then 'admin'
         when coalesce(qual, with_check) like '%auth_org_ids%'      then 'any member'
         else '(other)'
       end as requires
from pg_policies
where schemaname = 'public'
  and tablename in ('printers', 'printer_config', 'app_settings',
                    'memberships', 'integrations', 'api_keys', 'print_jobs',
                    'form_entries')
  and policyname not like 'platform admins%'
order by tablename, cmd, policyname;
