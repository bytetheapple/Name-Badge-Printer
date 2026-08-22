-- ============================================================================
-- Multi-tenant Phase A1 — step 1 of 3: FOUNDATIONS (additive only)
--
-- Adds the tenant tables (organizations / memberships / platform_admins), the
-- membership helpers, and a nullable `org_id` on every tenant table. Nothing
-- here changes existing behaviour: no RLS policy is touched and no column
-- becomes NOT NULL, so the live single-tenant deployment keeps working exactly
-- as before.
--
-- Apply in order: this file, then _backfill, then _rls.
-- See MULTI_TENANT_DESIGN.md §3 (data model) and §14 (migration).
-- ============================================================================

-- ---------------------------------------------------------------- 1. tenants

-- A tenant: one customer (a congregation).
create table if not exists public.organizations (
  id         uuid primary key default gen_random_uuid(),
  slug       text unique not null,        -- human-friendly, admin-facing
  name       text not null,
  plan       text not null default 'pilot',   -- billing hook (unused for now)
  status     text not null default 'active'
               check (status in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

-- Which users belong to which org, and as what. A user may belong to several
-- orgs (e.g. the operator, for support).
create table if not exists public.memberships (
  org_id     uuid not null references public.organizations (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null default 'staff'
               check (role in ('owner', 'admin', 'staff')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists memberships_user_id_idx on public.memberships (user_id);

-- Platform operators (us). Deliberately NOT a tenant role.
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- 2. helpers

-- The orgs the calling user belongs to. SECURITY DEFINER so RLS policies can
-- call it without recursing into memberships' own policies.
create or replace function public.auth_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id from public.memberships where user_id = auth.uid()
$$;

-- Cross-tenant operator check, used by the platform-admin policies.
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

-- TRANSITIONAL (remove in Phase A4). Resolves an org for a row written by a
-- caller that does not supply one yet — today that is the public sign-in and
-- print-API Edge Functions, which still run single-tenant with the service_role
-- key. Deliberately returns NULL as soon as the situation is ambiguous (the
-- writer belongs to several orgs, or a second org exists), so a NOT NULL
-- violation is raised rather than a row being silently misfiled into the wrong
-- tenant. In other words: onboarding a second org REQUIRES finishing A4 first.
create or replace function public.default_org_id()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ids uuid[];
begin
  -- 1. An authenticated writer who belongs to exactly one org.
  select array_agg(org_id) into ids
  from (select org_id from public.memberships where user_id = auth.uid() limit 2) t;
  if array_length(ids, 1) = 1 then
    return ids[1];
  end if;

  -- 2. Otherwise: the only org, if there is exactly one (single-tenant today).
  select array_agg(id) into ids from (select id from public.organizations limit 2) t;
  if array_length(ids, 1) = 1 then
    return ids[1];
  end if;

  return null;
end;
$$;

-- Fills org_id on insert when the writer did not supply one. Prefers the
-- printer's org (form_entries / print_jobs both carry printer_id) and falls
-- back to default_org_id(). TRANSITIONAL, same as above.
create or replace function public.set_org_id_default()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- jsonb_exists() rather than the `?` operator: some SQL clients treat `?`
  -- as a bind placeholder.
  if new.org_id is null and jsonb_exists(to_jsonb(new), 'printer_id') then
    select p.org_id into new.org_id
    from public.printers p
    where p.id = (to_jsonb(new) ->> 'printer_id')::uuid;
  end if;

  if new.org_id is null then
    new.org_id := public.default_org_id();
  end if;

  return new;
end;
$$;

-- ------------------------------------------------- 3. org_id on tenant tables
-- Nullable at this step; backfilled and constrained in the next migration.

alter table public.form_entries   add column if not exists org_id uuid references public.organizations (id) on delete cascade;
alter table public.print_jobs     add column if not exists org_id uuid references public.organizations (id) on delete cascade;
alter table public.printers       add column if not exists org_id uuid references public.organizations (id) on delete cascade;
alter table public.printer_config add column if not exists org_id uuid references public.organizations (id) on delete cascade;
alter table public.printer_status add column if not exists org_id uuid references public.organizations (id) on delete cascade;
alter table public.app_settings   add column if not exists org_id uuid references public.organizations (id) on delete cascade;

create index if not exists form_entries_org_id_idx on public.form_entries (org_id);
create index if not exists print_jobs_org_id_idx   on public.print_jobs (org_id);
create index if not exists printers_org_id_idx     on public.printers (org_id);

-- ------------------------------------------ 4. singletons become per-org rows
-- printer_config / printer_status / app_settings were single rows pinned to
-- id = 1. They become one row per org: drop the id = 1 check, give id a
-- sequence so further orgs get 2, 3, …, and make org_id unique per table.
-- The existing id = 1 row is untouched, so the deployed app (which still reads
-- `id = eq.1`) keeps working until the admin is made org-aware in A2.

-- Drop by definition rather than by name, so a differently-named constraint
-- (e.g. a "_check1" suffix) cannot silently survive and pin every org to id 1.
do $$
declare
  c record;
begin
  for c in
    select rel.relname as tbl, con.conname as name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname in ('printer_config', 'printer_status', 'app_settings')
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%id = 1%'
  loop
    execute format('alter table public.%I drop constraint %I', c.tbl, c.name);
    raise notice 'dropped singleton constraint %.%', c.tbl, c.name;
  end loop;
end;
$$;

create sequence if not exists public.printer_config_id_seq owned by public.printer_config.id;
create sequence if not exists public.printer_status_id_seq owned by public.printer_status.id;
create sequence if not exists public.app_settings_id_seq   owned by public.app_settings.id;

select setval('public.printer_config_id_seq', coalesce((select max(id) from public.printer_config), 1));
select setval('public.printer_status_id_seq', coalesce((select max(id) from public.printer_status), 1));
select setval('public.app_settings_id_seq',   coalesce((select max(id) from public.app_settings), 1));

alter table public.printer_config alter column id set default nextval('public.printer_config_id_seq');
alter table public.printer_status alter column id set default nextval('public.printer_status_id_seq');
alter table public.app_settings   alter column id set default nextval('public.app_settings_id_seq');

create unique index if not exists printer_config_org_id_key on public.printer_config (org_id);
create unique index if not exists printer_status_org_id_key on public.printer_status (org_id);
create unique index if not exists app_settings_org_id_key   on public.app_settings (org_id);

-- ----------------------------------------------------------------- 5. grants
-- New tables/functions are not auto-exposed to the Data API roles, so grant
-- explicitly. RLS (added in the third migration) is what actually restricts
-- these; the grants only make them reachable through PostgREST.

grant select on public.organizations   to authenticated;
grant select on public.memberships     to authenticated;
grant select on public.platform_admins to authenticated;

grant execute on function public.auth_org_ids()      to authenticated;
grant execute on function public.is_platform_admin() to authenticated;
