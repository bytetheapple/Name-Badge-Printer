-- ============================================================================
-- Multi-tenant Phase A2 — roles & member management
--
-- A1 answered "which org does this row belong to". A2 answers "what may this
-- member do with it": owner / admin / staff (MULTI_TENANT_DESIGN.md §5).
--
--   staff  — read entries, reprint, test-print. No settings, no members.
--   admin  — + manage printers, printer config, settings; manage staff.
--   owner  — + manage admins and owners, rename the org.
--
-- Reads stay membership-wide (any role sees all of their org's rows); only
-- writes narrow. Existing users were backfilled as `owner` in A1, so nobody
-- loses access when this lands.
--
-- Additive and idempotent: safe to paste more than once.
-- ============================================================================

-- ---------------------------------------------------------------- 1. helpers

-- The caller's role in one org, or null if they are not a member.
create or replace function public.auth_org_role(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select m.role
  from public.memberships m
  where m.org_id = p_org and m.user_id = auth.uid()
$$;

create or replace function public.auth_is_org_admin(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.auth_org_role(p_org) in ('owner', 'admin')
$$;

create or replace function public.auth_is_org_owner(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.auth_org_role(p_org) = 'owner'
$$;

grant execute on function public.auth_org_role(uuid)     to authenticated;
grant execute on function public.auth_is_org_admin(uuid) to authenticated;
grant execute on function public.auth_is_org_owner(uuid) to authenticated;

-- The member list for one org, with emails. auth.users is not reachable from
-- the Data API, so this security-definer function is the only way in — and it
-- returns nothing unless the caller belongs to the org (or is a platform
-- admin), which is what stops it becoming a cross-tenant email dump.
create or replace function public.org_members(p_org uuid)
returns table (user_id uuid, email text, role text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.org_id = p_org
    and (p_org in (select public.auth_org_ids()) or public.is_platform_admin())
  order by m.created_at
$$;

grant execute on function public.org_members(uuid) to authenticated;

-- ------------------------------------------------- 2. role-aware write policies
-- Reads are untouched (any member sees their org). Only the write side narrows.

-- printers: admins and owners manage them; staff may not.
drop policy if exists "org insert printers" on public.printers;
create policy "org insert printers" on public.printers
  for insert to authenticated
  with check (public.auth_is_org_admin(org_id));

drop policy if exists "org update printers" on public.printers;
create policy "org update printers" on public.printers
  for update to authenticated
  using (public.auth_is_org_admin(org_id))
  with check (public.auth_is_org_admin(org_id));

drop policy if exists "org delete printers" on public.printers;
create policy "org delete printers" on public.printers
  for delete to authenticated
  using (public.auth_is_org_admin(org_id));

-- printer_config / app_settings: admin-and-up to change; anyone to read.
drop policy if exists "org update printer_config" on public.printer_config;
create policy "org update printer_config" on public.printer_config
  for update to authenticated
  using (public.auth_is_org_admin(org_id))
  with check (public.auth_is_org_admin(org_id));

drop policy if exists "org update app_settings" on public.app_settings;
create policy "org update app_settings" on public.app_settings
  for update to authenticated
  using (public.auth_is_org_admin(org_id))
  with check (public.auth_is_org_admin(org_id));

-- A new org has no per-org singleton rows until someone provisions them (A6),
-- so let its admins create them. One row per org is enforced by the unique
-- index on org_id from A1.
drop policy if exists "org insert printer_config" on public.printer_config;
create policy "org insert printer_config" on public.printer_config
  for insert to authenticated
  with check (public.auth_is_org_admin(org_id));

drop policy if exists "org insert app_settings" on public.app_settings;
create policy "org insert app_settings" on public.app_settings
  for insert to authenticated
  with check (public.auth_is_org_admin(org_id));

drop policy if exists "org insert printer_status" on public.printer_status;
create policy "org insert printer_status" on public.printer_status
  for insert to authenticated
  with check (public.auth_is_org_admin(org_id));

-- print_jobs insert is deliberately left membership-wide: reprinting a badge
-- and running a test print are exactly what staff are for.

-- ------------------------------------------------------- 3. renaming the org

drop policy if exists "owner updates organization" on public.organizations;
create policy "owner updates organization" on public.organizations
  for update to authenticated
  using (public.auth_is_org_owner(id))
  with check (public.auth_is_org_owner(id));

-- ------------------------------------------------------- 4. managing members
-- An admin may only create, change and remove *staff*. Owners may manage any
-- role. In USING, `memberships.role` is the row as it stands; in WITH CHECK it
-- is the row as it would become — so both the current and the target role must
-- be within the caller's authority.

drop policy if exists "manage org memberships insert" on public.memberships;
create policy "manage org memberships insert" on public.memberships
  for insert to authenticated
  with check (
    public.auth_is_org_admin(org_id)
    and (memberships.role = 'staff' or public.auth_is_org_owner(org_id))
  );

drop policy if exists "manage org memberships update" on public.memberships;
create policy "manage org memberships update" on public.memberships
  for update to authenticated
  using (
    public.auth_is_org_admin(org_id)
    and (memberships.role = 'staff' or public.auth_is_org_owner(org_id))
  )
  with check (
    public.auth_is_org_admin(org_id)
    and (memberships.role = 'staff' or public.auth_is_org_owner(org_id))
  );

drop policy if exists "manage org memberships delete" on public.memberships;
create policy "manage org memberships delete" on public.memberships
  for delete to authenticated
  using (
    public.auth_is_org_admin(org_id)
    and (memberships.role = 'staff' or public.auth_is_org_owner(org_id))
  );

-- ------------------------------------------------- 5. never orphan an org
-- RLS cannot express "but not the last one", so a trigger does. Without it an
-- owner could demote or delete themselves and leave the org unadministrable.

create or replace function public.prevent_last_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owners int;
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' then
    return new;                                  -- still an owner, nothing lost
  end if;

  select count(*) into owners
  from public.memberships
  where org_id = old.org_id and role = 'owner';

  if owners <= 1 then
    raise exception
      'cannot remove the last owner of this organization — promote another owner first'
      using errcode = 'restrict_violation';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists memberships_prevent_last_owner_update on public.memberships;
create trigger memberships_prevent_last_owner_update
  before update on public.memberships
  for each row execute function public.prevent_last_owner_removal();

drop trigger if exists memberships_prevent_last_owner_delete on public.memberships;
create trigger memberships_prevent_last_owner_delete
  before delete on public.memberships
  for each row execute function public.prevent_last_owner_removal();
