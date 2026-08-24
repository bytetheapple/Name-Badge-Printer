-- ============================================================================
-- Multi-tenant Phase A5 — per-tenant integrations & secrets
--
-- Google Forms, ShulCloud and the Drive service account are still configured
-- with project-wide environment variables. RLS cannot help with that: the leak
-- would happen outside the database, with a second congregation's visitors
-- landing in Shir Hadash's Google Form. This is the phase that fixes it
-- (MULTI_TENANT_DESIGN.md §11).
--
-- Two kinds of setting, stored differently on purpose:
--
--   * Non-secret config — form URLs, field ids, toggles — lives in `config`
--     jsonb, readable and editable by that org's admins so they can set their
--     own integrations up.
--   * Real credentials — currently just the Google service-account private key
--     — live in Supabase Vault. They can be written by an org admin and read
--     only by the Edge Functions; there is no path that hands one back to a
--     browser, not even to the admin who set it.
--
-- The selfie Drive *folder* stays in app_settings, where it already is and
-- already is per-org: it is a setting, not a credential.
--
-- Additive and idempotent. Existing behaviour is untouched — the sync functions
-- fall back to the environment variables for an org with nothing configured,
-- so Shir Hadash keeps working until its settings are moved over deliberately.
-- ============================================================================

-- Vault is normally already installed on a Supabase project. Install it if it
-- is merely available, and say so plainly if it is not — rather than failing
-- later, at the first attempt to save a credential.
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'vault' and p.proname = 'create_secret'
  ) then
    if exists (select 1 from pg_available_extensions where name = 'supabase_vault') then
      execute 'create extension if not exists supabase_vault with schema vault';
    else
      raise exception
        'Supabase Vault is not available on this database. Enable the supabase_vault extension (Database -> Extensions) before applying this migration.';
    end if;
  end if;
end;
$$;

-- ------------------------------------------- 0. make the role helpers total
-- auth_org_role() returns NULL for a non-member, and `NULL in ('owner','admin')`
-- is NULL rather than false. RLS treats that as deny, so the A2-A4 policies were
-- never at risk — but a PL/pgSQL guard written as `if not auth_is_org_admin(...)`
-- skips its branch on NULL and lets the caller straight through. The functions
-- below need exactly such a guard, so the helpers are made total first.

create or replace function public.auth_is_org_admin(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.auth_org_role(p_org) in ('owner', 'admin'), false)
$$;

create or replace function public.auth_is_org_owner(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.auth_org_role(p_org) = 'owner', false)
$$;

-- --------------------------------------- 0b. let an organization be deleted
-- Deleting an org cascades to memberships, and the A2 last-owner guard fired on
-- that cascade — so an org with an owner (i.e. every org) could never be
-- removed at all. Offboarding a tenant, and cleaning up after a trial, both
-- need it to be possible.
--
-- The guard exists to stop an org being left with nobody who can administer it.
-- If the organization itself is going away there is nothing left to strand, and
-- by the time the cascade reaches memberships the parent row is already gone
-- inside the transaction — which is exactly what distinguishes the two cases.

create or replace function public.prevent_last_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owners int;
begin
  if tg_op = 'DELETE'
     and not exists (select 1 from public.organizations where id = old.org_id) then
    return old;                                  -- the whole org is being deleted
  end if;

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

-- ------------------------------------------------------------ 1. the table

create table if not exists public.integrations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  kind       text not null check (kind in ('google_form', 'shulcloud', 'google_drive')),
  enabled    boolean not null default false,
  config     jsonb   not null default '{}'::jsonb,
  -- Points into Vault. Never exposed through the Data API; see the grants below.
  secret_id  uuid,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (org_id, kind)
);

create index if not exists integrations_org_id_idx on public.integrations (org_id);

drop trigger if exists integrations_set_updated_at on public.integrations;
create trigger integrations_set_updated_at
  before update on public.integrations
  for each row execute function public.set_updated_at();

alter table public.integrations enable row level security;

drop policy if exists "org read integrations" on public.integrations;
create policy "org read integrations" on public.integrations
  for select to authenticated using (public.auth_is_org_admin(org_id));

drop policy if exists "org insert integrations" on public.integrations;
create policy "org insert integrations" on public.integrations
  for insert to authenticated with check (public.auth_is_org_admin(org_id));

drop policy if exists "org update integrations" on public.integrations;
create policy "org update integrations" on public.integrations
  for update to authenticated
  using (public.auth_is_org_admin(org_id))
  with check (public.auth_is_org_admin(org_id));

drop policy if exists "org delete integrations" on public.integrations;
create policy "org delete integrations" on public.integrations
  for delete to authenticated using (public.auth_is_org_admin(org_id));

-- Revoke first: this project grants the Data API roles everything on a new
-- table. secret_id is deliberately absent from the select grant — knowing which
-- Vault row holds a credential is not something a browser needs.
revoke all on public.integrations from anon, authenticated;
grant select (id, org_id, kind, enabled, config, updated_at, created_at)
  on public.integrations to authenticated;
grant insert (org_id, kind, enabled, config) on public.integrations to authenticated;
grant update (enabled, config) on public.integrations to authenticated;
grant delete on public.integrations to authenticated;

-- --------------------------------------------------- 2. writing a credential
-- An org admin can set a secret without ever being able to read it back. The
-- membership check is inside the function because SECURITY DEFINER bypasses the
-- RLS that would otherwise do this job.

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
  if not coalesce(public.auth_is_org_admin(p_org), false) then
    raise exception 'not an administrator of this organization'
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
  if not coalesce(public.auth_is_org_admin(p_org), false) then
    raise exception 'not an administrator of this organization'
      using errcode = 'insufficient_privilege';
  end if;

  select secret_id into v_secret from public.integrations where org_id = p_org and kind = p_kind;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
    update public.integrations set secret_id = null where org_id = p_org and kind = p_kind;
  end if;
end;
$$;

-- Whether a credential is set, without revealing it — so the admin UI can show
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
      where org_id = p_org and kind = p_kind and public.auth_is_org_admin(p_org)),
    false)
$$;

grant execute on function public.set_integration_secret(uuid, text, text) to authenticated;
grant execute on function public.clear_integration_secret(uuid, text)     to authenticated;
grant execute on function public.integration_has_secret(uuid, text)       to authenticated;

-- ------------------------------------------ 2b. credentials die with their row
-- integrations rows cascade away when an org is deleted, but the Vault rows
-- they point at have no such link — a removed tenant would leave its
-- credentials sitting in the vault indefinitely. This closes that.

create or replace function public.delete_integration_secret()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.secret_id is not null then
    delete from vault.secrets where id = old.secret_id;
  end if;
  return old;
end;
$$;

drop trigger if exists integrations_delete_secret on public.integrations;
create trigger integrations_delete_secret
  after delete on public.integrations
  for each row execute function public.delete_integration_secret();

-- ------------------------------------------------- 3. reading, for the server
-- One call gives an Edge Function everything it needs for one org's
-- integration. EXECUTE comes off PUBLIC — this is the only path to a decrypted
-- credential, and no browser role may take it.

create or replace function public.integration_for(p_org uuid, p_kind text)
returns table (enabled boolean, config jsonb, secret text)
language sql
stable
security definer
set search_path = public
as $$
  select i.enabled,
         i.config,
         (select s.decrypted_secret from vault.decrypted_secrets s where s.id = i.secret_id)
  from public.integrations i
  where i.org_id = p_org and i.kind = p_kind
$$;

-- Revoking from PUBLIC is not enough on its own: this project grants the Data
-- API roles EXECUTE on newly created functions, and a direct grant to a role
-- survives a revoke from PUBLIC. They have to be named.
revoke all on function public.integration_for(uuid, text)
  from public, anon, authenticated;
grant execute on function public.integration_for(uuid, text) to service_role;
