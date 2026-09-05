-- Putting a print server onto a wireless network, from the admin console.
--
-- Why this exists: a print server reaches only the printers on a network it
-- shares. At one site the server was on a wired drop that could not route to
-- the printer's WiFi, and the fix needed a shell on the Pi. This is that fix
-- without the shell.
--
-- The shape is deliberately narrow. One open request per organization, the
-- passphrase in Vault and never in a column, and the secret destroyed the
-- moment it has been handed over. The bridge applies it with a rollback, so a
-- wrong passphrase costs a minute rather than a site visit.

create table if not exists public.server_network_requests (
  id      uuid primary key default gen_random_uuid(),
  org_id  uuid not null references public.organizations (id) on delete cascade,

  -- The name of a network is not a secret: it is broadcast to the building.
  ssid    text not null,

  -- Vault id of the passphrase, null once spent. What gets you onto the
  -- network is the customer's, is needed exactly once, and has no business
  -- resting anywhere readable.
  secret  uuid,

  state   text not null default 'pending'
          check (state in ('pending', 'sent', 'applied', 'failed')),
  error   text,

  requested_by uuid references auth.users (id) on delete set null,
  sent_at    timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists server_network_requests_org_idx
  on public.server_network_requests (org_id, created_at desc);

-- One at a time. Two queued changes to the same radio is a way to lose a
-- server: the second would be applied to a machine still recovering from the
-- first, and neither operator would know whose passphrase was in play.
create unique index if not exists server_network_requests_one_open
  on public.server_network_requests (org_id)
  where state in ('pending', 'sent');

alter table public.server_network_requests enable row level security;

-- Readable by the admins of the org it belongs to, so they can watch it land.
-- Not insertable directly: the passphrase must go through the function below,
-- which is the only thing that can put it somewhere encrypted.
drop policy if exists "org admin read network requests" on public.server_network_requests;
create policy "org admin read network requests" on public.server_network_requests
  for select to authenticated
  using (public.auth_is_org_admin(org_id));

drop policy if exists "org admin delete network requests" on public.server_network_requests;
create policy "org admin delete network requests" on public.server_network_requests
  for delete to authenticated
  using (public.auth_is_org_admin(org_id));

grant select, delete on public.server_network_requests to authenticated;

-- --------------------------------------------------------------- the request
create or replace function public.request_server_network(
  p_org        uuid,
  p_ssid       text,
  p_passphrase text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_secret uuid;
begin
  if not coalesce(public.auth_is_org_admin(p_org), false) then
    raise exception 'not an administrator of this organization'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_ssid), '') = '' then
    raise exception 'a network name is required';
  end if;

  -- An open request is replaced rather than rejected: the operator standing
  -- there has almost certainly just mistyped the passphrase, and making them
  -- hunt for a Cancel button to correct it is the wrong answer.
  delete from public.server_network_requests
   where org_id = p_org and state in ('pending', 'sent');

  insert into public.server_network_requests (org_id, ssid, requested_by)
  values (p_org, trim(p_ssid), auth.uid())
  returning id into v_id;

  if coalesce(p_passphrase, '') <> '' then
    v_secret := vault.create_secret(
      p_passphrase,
      'server_network_' || v_id::text,
      'Print server WiFi passphrase, deleted once applied'
    );
    update public.server_network_requests set secret = v_secret where id = v_id;
  end if;

  return v_id;
end;
$$;

-- Read once, by the Edge Function handing it to the bridge. Never exposed to
-- a browser: `authenticated` is deliberately absent from the grant below.
create or replace function public.take_server_network_secret(p_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_secret uuid;
  v_value  text;
begin
  select secret into v_secret from public.server_network_requests where id = p_id;
  if v_secret is null then
    return null;
  end if;
  select decrypted_secret into v_value
    from vault.decrypted_secrets where id = v_secret;
  return v_value;
end;
$$;

create or replace function public.clear_server_network_secret(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_secret uuid;
begin
  select secret into v_secret from public.server_network_requests where id = p_id;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
  end if;
  update public.server_network_requests set secret = null where id = p_id;
end;
$$;

-- A deleted request must not leave its passphrase behind in Vault. Works from
-- the OLD row, because by the time this runs the row is gone.
create or replace function public.delete_server_network_secret()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.secret is not null then
    delete from vault.secrets where id = old.secret;
  end if;
  return old;
end;
$$;

drop trigger if exists server_network_requests_secret_gone on public.server_network_requests;
create trigger server_network_requests_secret_gone
  after delete on public.server_network_requests
  for each row execute function public.delete_server_network_secret();

revoke all on function public.request_server_network(uuid, text, text) from public;
revoke all on function public.take_server_network_secret(uuid) from public;
revoke all on function public.clear_server_network_secret(uuid) from public;
grant execute on function public.request_server_network(uuid, text, text) to authenticated;
grant execute on function public.take_server_network_secret(uuid) to service_role;
grant execute on function public.clear_server_network_secret(uuid) to service_role;
