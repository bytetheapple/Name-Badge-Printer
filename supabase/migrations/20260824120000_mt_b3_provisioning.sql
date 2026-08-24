-- ============================================================================
-- Phase B3 — provision a printer from the admin, not from a terminal
--
-- provision.py walks one printer from "out of the box" to "on the WiFi and
-- discoverable". Half its steps are things only a person standing at the
-- printer can do (factory reset, the first-run wizard, the power cycle); the
-- other half are things only the bridge can do, because the printer is on the
-- customer's LAN and neither this database nor the admin page can reach it.
--
-- So a session is a small state machine that both sides advance: the operator
-- pushes it through the physical steps in the browser, and the bridge picks up
-- the machine steps on its next poll and reports back. Nothing here talks to a
-- printer — this is only the shared notepad they take turns writing on.
--
-- Additive and idempotent.
-- ============================================================================

-- ---------------------------------------------------------------- the session
create table if not exists public.provisioning_sessions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,

  -- Where in the walkthrough this is. See PROVISIONING_STATES below; the check
  -- is deliberately a list rather than an enum so a later phase can add a step
  -- without an enum migration and the type churn that brings.
  state       text not null default 'reset',

  -- What the operator told us up front.
  printer_name text,
  location     text,
  ssid         text,

  -- What we learn along the way.
  candidates   jsonb not null default '[]'::jsonb,   -- [{ip, mac, model, via}]
  wired_ip     text,
  model        text,
  serial       text,
  firmware     text,
  wireless_mac text,
  wireless_ip  text,
  printer_id   uuid references public.printers (id) on delete set null,

  -- Handing a machine step to the bridge. `task_started_at` is stamped as the
  -- step is handed over, so one ask produces one attempt even though the
  -- bridge may poll again before it finishes — the same guard the scan request
  -- uses, for the same reason.
  task_started_at timestamptz,

  -- Vault ids of the operator's secrets, keyed by kind. Never the secrets
  -- themselves: see set_provisioning_secret below.
  secrets      jsonb not null default '{}'::jsonb,

  -- Everything the bridge reported, oldest first: [{at, step, ok, text}].
  log          jsonb not null default '[]'::jsonb,
  error        text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint provisioning_sessions_state_check check (state in (
    -- waiting on the person at the printer
    'reset', 'first_run', 'cable', 'select', 'wifi_confirm', 'power_cycle',
    -- waiting on the bridge
    'discover', 'configure', 'wifi', 'rediscover',
    -- terminal
    'done', 'failed'
  ))
);

create index if not exists provisioning_sessions_org_idx
  on public.provisioning_sessions (org_id, created_at desc);

-- The bridge looks for work by state, across every org it serves.
create index if not exists provisioning_sessions_pending_idx
  on public.provisioning_sessions (state)
  where state in ('discover', 'configure', 'wifi', 'rediscover');

create or replace function public.touch_provisioning_session()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists provisioning_sessions_touch on public.provisioning_sessions;
create trigger provisioning_sessions_touch
  before update on public.provisioning_sessions
  for each row execute function public.touch_provisioning_session();

alter table public.provisioning_sessions enable row level security;

-- Provisioning changes hardware settings and carries the site's WiFi
-- credentials, so it is an administrator's job throughout — staff who can see
-- the printer list have no reason to see this at all.
drop policy if exists "org admin read provisioning" on public.provisioning_sessions;
create policy "org admin read provisioning" on public.provisioning_sessions
  for select to authenticated
  using (public.auth_is_org_admin(org_id));

drop policy if exists "org admin write provisioning" on public.provisioning_sessions;
create policy "org admin write provisioning" on public.provisioning_sessions
  for insert to authenticated
  with check (public.auth_is_org_admin(org_id));

drop policy if exists "org admin update provisioning" on public.provisioning_sessions;
create policy "org admin update provisioning" on public.provisioning_sessions
  for update to authenticated
  using (public.auth_is_org_admin(org_id))
  with check (public.auth_is_org_admin(org_id));

drop policy if exists "org admin delete provisioning" on public.provisioning_sessions;
create policy "org admin delete provisioning" on public.provisioning_sessions
  for delete to authenticated
  using (public.auth_is_org_admin(org_id));

-- --------------------------------------------------------------- the secrets
-- Two secrets pass through here: the printer's web password (the code on the
-- back) and the site's WiFi passphrase. The bridge needs both to do its job,
-- so they cannot be write-only — but they are the customer's, not ours, and
-- they have no business resting in a column anyone with the table can read.
--
-- They go into Vault, encrypted, and they are deleted the moment the session
-- ends. An admin can set one and can clear it; nothing but the Edge Functions
-- can read one back.

create or replace function public.set_provisioning_secret(
  p_session uuid,
  p_kind    text,
  p_secret  text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row    public.provisioning_sessions%rowtype;
  v_name   text;
  v_secret uuid;
  v_existing uuid;
begin
  if p_kind not in ('web_password', 'wifi_passphrase') then
    raise exception 'unknown provisioning secret %', p_kind;
  end if;

  select * into v_row from public.provisioning_sessions where id = p_session;
  if not found then
    raise exception 'no such provisioning session';
  end if;
  if not coalesce(public.auth_is_org_admin(v_row.org_id), false) then
    raise exception 'not an administrator of this organization'
      using errcode = 'insufficient_privilege';
  end if;
  if p_secret is null or length(p_secret) = 0 then
    raise exception 'the secret is empty';
  end if;

  v_name := format('prov:%s:%s', p_session, p_kind);
  v_existing := nullif(v_row.secrets ->> p_kind, '')::uuid;

  if v_existing is null then
    v_secret := vault.create_secret(p_secret, v_name, 'Name Badge Kiosk provisioning secret');
    update public.provisioning_sessions
       set secrets = secrets || jsonb_build_object(p_kind, v_secret::text)
     where id = p_session;
  else
    perform vault.update_secret(v_existing, p_secret);
  end if;
end;
$$;

-- Read back for the bridge. SECURITY DEFINER and takes a session id, so it is
-- only safe while nothing but the Edge Functions can call it — see the grants
-- at the foot of this file, and the note there about why revoking from PUBLIC
-- is not enough on this project.
create or replace function public.provisioning_secret(p_session uuid, p_kind text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select nullif(secrets ->> p_kind, '')::uuid
    into v_id
    from public.provisioning_sessions
   where id = p_session;
  if v_id is null then
    return null;
  end if;
  return (select decrypted_secret from vault.decrypted_secrets where id = v_id);
end;
$$;

-- Forget both of them. Called when a session finishes, is abandoned, or fails:
-- once the printer is on the network the passphrase has done its job, and
-- keeping it would turn a transient credential into a stored one.
create or replace function public.clear_provisioning_secrets(p_session uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.provisioning_sessions%rowtype;
  v_id  uuid;
begin
  select * into v_row from public.provisioning_sessions where id = p_session;
  if not found then
    return;
  end if;
  -- Callable by an admin of the org, and by the Edge Functions (which run as
  -- service_role and have no JWT, so the admin check cannot apply to them).
  if auth.uid() is not null
     and not coalesce(public.auth_is_org_admin(v_row.org_id), false) then
    raise exception 'not an administrator of this organization'
      using errcode = 'insufficient_privilege';
  end if;

  for v_id in select (jsonb_each_text(v_row.secrets)).value::uuid loop
    delete from vault.secrets where id = v_id;
  end loop;
  update public.provisioning_sessions set secrets = '{}'::jsonb where id = p_session;
end;
$$;

-- A deleted session must not leave its secrets behind in Vault. The row is
-- gone by the time this runs, so it works from the OLD copy rather than
-- calling clear_provisioning_secrets.
create or replace function public.delete_provisioning_secrets()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  for v_id in select (jsonb_each_text(old.secrets)).value::uuid loop
    delete from vault.secrets where id = v_id;
  end loop;
  return old;
end;
$$;

drop trigger if exists provisioning_sessions_secrets_gone on public.provisioning_sessions;
create trigger provisioning_sessions_secrets_gone
  after delete on public.provisioning_sessions
  for each row execute function public.delete_provisioning_secrets();

-- ----------------------------------------------------------------- the grants
-- `provisioning_secret()` returns a decrypted credential for whatever session
-- id it is handed, so an authenticated user who could call it would be able to
-- read another organization's WiFi passphrase. RLS cannot help: the function is
-- SECURITY DEFINER precisely so the bridge path can bypass it.
--
-- Revoking from PUBLIC is NOT sufficient here. This project grants the Data API
-- roles EXECUTE on newly created functions, and that grant is made to the role
-- by name at creation — a later `revoke … from public` leaves it in place. That
-- exact mistake shipped a live cross-tenant credential leak in A5; see
-- 20260823170000_mt_fix_function_grants.sql. Name the roles.
--
-- The reverse is equally true and bites just as hard: a new function is
-- EXECUTE-to-PUBLIC by default, so revoking from the two roles by name still
-- leaves every one of them able to call it *through* PUBLIC. Both revokes are
-- load-bearing. The isolation test fails if either is dropped.
revoke all on function public.provisioning_secret(uuid, text)
  from public, anon, authenticated;
grant execute on function public.provisioning_secret(uuid, text) to service_role;

-- These two are meant for admins in the browser, so they keep `authenticated`
-- and do their own permission check internally.
grant execute on function public.set_provisioning_secret(uuid, text, text) to authenticated, service_role;
grant execute on function public.clear_provisioning_secrets(uuid) to authenticated, service_role;

-- Verify: provisioning_secret must not list anon or authenticated.
select p.proname,
       coalesce(pg_catalog.array_to_string(p.proacl, ' | '), '(owner only)') as grants
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('provisioning_secret', 'set_provisioning_secret',
                    'clear_provisioning_secrets')
order by p.proname;
