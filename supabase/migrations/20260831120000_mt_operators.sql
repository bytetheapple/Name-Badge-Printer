-- ============================================================================
-- Operators
--
-- Guest Badges staff, as distinct from a customer's own people. Until now the
-- two were the same mechanism: an operator reached an organization by holding
-- a membership in it, which is why platform_overview() carries an
-- `operator_attached` column whose whole job is catching onboardings that were
-- never handed over.
--
-- This migration gives the operator list a shape the app can read and write.
-- What it does *not* do is give operators cross-tenant write — that is a
-- separate change to auth_org_ids() and auth_org_role(), deliberately kept
-- apart from this one.
--
-- Two roles, and the line between them is: an owner may do the irreversible
-- and may change who has access; a support operator may do everything else.
-- So `support` can view every customer, create one, issue a print-server
-- credential, and suspend (reversible, and a suspended congregation is
-- resumed in one click) — but cannot delete an organization and cannot add,
-- remove or re-role an operator.
--
-- The role is enforced from the moment it exists. A2's `status` column sat
-- unread for days and suspension silently did nothing; a permission column
-- nothing checks is worse than no column, because it reads as a control.
--
-- Additive and idempotent.
-- ============================================================================

-- ------------------------------------------------------------ the column
alter table public.platform_admins
  add column if not exists role text not null default 'owner';

-- Existing rows become owners: whoever is already an operator today got there
-- by hand in the SQL editor, which is the owner's job.
alter table public.platform_admins
  drop constraint if exists platform_admins_role_check;
alter table public.platform_admins
  add constraint platform_admins_role_check check (role in ('owner', 'support'));

--: Who added this operator. Null for the rows that predate this migration and
--: for anyone whose account was later deleted.
alter table public.platform_admins
  add column if not exists added_by uuid references auth.users (id) on delete set null;

comment on column public.platform_admins.role is
  'owner may delete organizations and manage operators; support may not.';

-- ------------------------------------------------------------- the check
create or replace function public.is_platform_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins
    where user_id = auth.uid() and role = 'owner'
  )
$$;

-- Reveals only the caller's own standing, so `authenticated` is right: the
-- console uses it to disable buttons rather than to offer them and then fail.
grant execute on function public.is_platform_owner() to authenticated, service_role;

-- --------------------------------------------------------------- the list
-- The table itself is readable one row at a time — your own — so that it
-- cannot become a list of who to attack. This is the only way to see the
-- whole of it, and it returns nothing to a caller who is not an operator.
-- The check is in the WHERE clause, so it is applied per row rather than
-- trusted to the caller.
create or replace function public.list_operators()
returns table (user_id uuid, email text, role text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select pa.user_id, u.email::text, pa.role, pa.created_at
  from public.platform_admins pa
  join auth.users u on u.id = pa.user_id
  where public.is_platform_admin()
  order by pa.created_at;
$$;

comment on function public.list_operators() is
  'Every Guest Badges operator with their email and role. Returns nothing to '
  'anyone who is not an operator.';

grant execute on function public.list_operators() to authenticated, service_role;

-- --------------------------------------------------------------- re-roling
create or replace function public.set_operator_role(p_user uuid, p_role text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email   text;
  v_current text;
begin
  if not coalesce(public.is_platform_owner(), false) then
    raise exception 'only an owner can change an operator''s role'
      using errcode = 'insufficient_privilege';
  end if;
  if p_role not in ('owner', 'support') then
    raise exception 'an operator is either an owner or support';
  end if;

  select pa.role, u.email::text into v_current, v_email
  from public.platform_admins pa
  join auth.users u on u.id = pa.user_id
  where pa.user_id = p_user;
  if not found then
    raise exception 'that person is not an operator';
  end if;

  -- The lockout guard. Demoting the last owner would leave nobody able to add
  -- an operator, and platform_admins has no insert policy — recovery would
  -- mean going back to the SQL editor.
  if v_current = 'owner' and p_role <> 'owner'
     and (select count(*) from public.platform_admins where role = 'owner') = 1 then
    raise exception 'this is the last owner; promote someone else first';
  end if;

  update public.platform_admins set role = p_role where user_id = p_user;
  return v_email;
end;
$$;

grant execute on function public.set_operator_role(uuid, text) to authenticated, service_role;

-- --------------------------------------------------------------- removing
-- Removing yourself is allowed, and is how an operator steps down — the guard
-- is about the last *owner*, not about self-removal. Stepping down from your
-- own console is a good deal less error-prone than a SQL statement.
create or replace function public.remove_operator(p_user uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email text;
  v_role  text;
begin
  if not coalesce(public.is_platform_owner(), false) then
    raise exception 'only an owner can remove an operator'
      using errcode = 'insufficient_privilege';
  end if;

  select pa.role, u.email::text into v_role, v_email
  from public.platform_admins pa
  join auth.users u on u.id = pa.user_id
  where pa.user_id = p_user;
  if not found then
    raise exception 'that person is not an operator';
  end if;

  if v_role = 'owner'
     and (select count(*) from public.platform_admins where role = 'owner') = 1 then
    raise exception 'this is the last owner; promote someone else first';
  end if;

  delete from public.platform_admins where user_id = p_user;
  -- The account itself survives. A person may be a member of a congregation
  -- as well, and deleting their login is a separate decision.
  return v_email;
end;
$$;

grant execute on function public.remove_operator(uuid) to authenticated, service_role;

-- ------------------------------------------------ the role, made to matter
-- Unchanged except for the guard: deleting a tenant is the one action in the
-- product with no undo, so it is the one that asks for an owner.
create or replace function public.delete_organization(p_org uuid, p_confirm_slug text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org  public.organizations%rowtype;
  v_gone jsonb;
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

  -- Typed by hand, and compared to the row we actually found rather than to
  -- anything the caller supplied alongside it.
  if btrim(coalesce(p_confirm_slug, '')) <> v_org.slug then
    raise exception 'to delete %, type its slug exactly: %', v_org.name, v_org.slug;
  end if;

  -- Counted before the delete, and returned, so the answer to "what did I just
  -- destroy?" exists after the fact rather than only in the confirmation.
  select jsonb_build_object(
    'name',        v_org.name,
    'slug',        v_org.slug,
    'printers',    (select count(*) from public.printers where org_id = p_org),
    'entries',     (select count(*) from public.form_entries where org_id = p_org),
    'print_jobs',  (select count(*) from public.print_jobs where org_id = p_org),
    'members',     (select count(*) from public.memberships where org_id = p_org),
    'bridges',     (select count(*) from public.bridge_tokens where org_id = p_org),
    'api_keys',    (select count(*) from public.api_keys where org_id = p_org)
  ) into v_gone;

  -- Everything that carries org_id cascades, and the two Vault-cleanup
  -- triggers (integrations, provisioning_sessions) fire on the cascaded rows,
  -- so no decrypted credential is left behind. A2's last-owner guard already
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

comment on function public.delete_organization(uuid, text) is
  'Delete a tenant and everything it owns. Platform owners only, and the slug '
  'must be typed to match. Returns what was destroyed. There is no undo.';

grant execute on function public.delete_organization(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice: the Supabase SQL editor discards notices.
-- Every operator should have a role, and exactly one owner is expected today.
select
  (select count(*) from public.platform_admins)                      as operators,
  (select count(*) from public.platform_admins where role = 'owner') as owners,
  (select count(*) from public.platform_admins where role is null)   as unroled;
