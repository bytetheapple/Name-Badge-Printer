-- ============================================================================
-- The device registry, and how a Pi claims its own credential
--
-- A print server is built on a bench and shipped. Until now that meant issuing
-- a credential by hand, writing it onto the card, and keeping track of which
-- card went where in someone's head.
--
-- The app cannot do the building — a browser has no TCP sockets, and Supabase's
-- cloud has no route to a bench LAN — so the Pi does it. It boots with a
-- one-time claim code, exchanges it for its own bridge credential, and appears
-- in the console. The same shape as the printer wizard: the device acts, the
-- server coordinates.
--
-- Nothing here is a secret at rest. The claim code is stored as a hash, the
-- bridge credential lives where it always did, and the operator's SSH private
-- key never comes near the system.
--
-- Additive and idempotent.
-- ============================================================================

create table if not exists public.pi_devices (
  id           uuid primary key default gen_random_uuid(),
  --: GuestBadgesServer0004, and also the Pi's hostname — so a device on a
  --: bench and a row in this table can be matched from either end.
  serial       text not null unique,
  --: Who it is being built for. Null while it is a spare.
  org_id       uuid references public.organizations (id) on delete set null,
  --: Written down at build time, because an organization can be renamed or
  --: deleted and "what did I ship them" outlives both.
  customer     text,
  notes        text,

  --: sha256 of the claim code. Single use: redeeming stamps claimed_at, and a
  --: code that has been claimed is refused rather than re-issued.
  claim_hash   text not null unique,
  claim_prefix text,
  claimed_at   timestamptz,
  --: The credential the claim produced, so a device can be traced to the token
  --: it is running on, and back.
  bridge_token_id uuid references public.bridge_tokens (id) on delete set null,

  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users (id) on delete set null
);

create index if not exists pi_devices_org_idx on public.pi_devices (org_id);
create index if not exists pi_devices_claim_idx on public.pi_devices (claim_hash);

alter table public.pi_devices enable row level security;

-- The fleet is the platform team's business. A congregation has no use for
-- serial numbers, including its own — what it needs about its print server is
-- already on the Platform console.
drop policy if exists "platform admins read pi_devices" on public.pi_devices;
create policy "platform admins read pi_devices" on public.pi_devices
  for select to authenticated
  using (public.is_platform_admin());

-- This project grants the Data API roles full access to new tables, so the
-- policy above is only half the job.
revoke all on public.pi_devices from anon, authenticated;
grant select on public.pi_devices to authenticated;

-- ------------------------------------------------------------- allocating
-- The serial is allocated, never typed, so it cannot collide or skip.
create or replace function public.allocate_pi_device(
  p_org      uuid default null,
  p_customer text default null,
  p_notes    text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_next   int;
  v_serial text;
  v_code   text;
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'only the Name Badge Kiosk team can build a print server'
      using errcode = 'insufficient_privilege';
  end if;
  if p_org is not null and not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'no such organization';
  end if;

  -- Highest existing number plus one, not a row count: a deleted device must
  -- never hand its serial to a second one. Past 9999 this keeps counting and
  -- the name simply gets longer, which beats wrapping.
  select coalesce(max((regexp_replace(serial, '\D', '', 'g'))::int), 0) + 1
    into v_next
    from public.pi_devices
   where serial ~ '^GuestBadgesServer[0-9]+$';

  v_serial := 'GuestBadgesServer' || lpad(v_next::text, 4, '0');

  -- Randomness without pgcrypto, as elsewhere in this schema.
  v_code := 'gbc_'
    || replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');

  insert into public.pi_devices
    (serial, org_id, customer, notes, claim_hash, claim_prefix, created_by)
  values (
    v_serial, p_org, nullif(btrim(p_customer), ''), nullif(btrim(p_notes), ''),
    encode(sha256(convert_to(v_code, 'utf8')), 'hex'),
    left(v_code, 12),
    auth.uid()
  );

  -- Returned once. Only the hash is kept, so there is no route back to it.
  return jsonb_build_object('serial', v_serial, 'claim_code', v_code);
end;
$$;

comment on function public.allocate_pi_device(uuid, text, text) is
  'Reserve the next serial and a one-time claim code for a print server being '
  'built. Platform admins only. The claim code is returned once.';

grant execute on function public.allocate_pi_device(uuid, text, text) to authenticated, service_role;

-- --------------------------------------------------------------- claiming
create or replace function public.claim_pi_device(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_dev    public.pi_devices%rowtype;
  v_secret text;
  v_token  uuid;
begin
  select * into v_dev
    from public.pi_devices
   where claim_hash = encode(sha256(convert_to(coalesce(p_code, ''), 'utf8')), 'hex');
  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown claim code');
  end if;
  if v_dev.claimed_at is not null then
    -- Spent. A second device presenting it is either a mistake or a copied
    -- card, and re-issuing would hand two devices one identity.
    return jsonb_build_object('ok', false, 'error', 'this claim code has already been used');
  end if;
  if v_dev.org_id is null then
    return jsonb_build_object('ok', false, 'error',
      'this print server has not been assigned to an organization yet');
  end if;

  v_secret := 'nbk_'
    || replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');

  insert into public.bridge_tokens (org_id, name, token_hash, token_prefix)
  values (
    v_dev.org_id, v_dev.serial,
    encode(sha256(convert_to(v_secret, 'utf8')), 'hex'),
    left(v_secret, 12)
  )
  returning id into v_token;

  update public.pi_devices
     set claimed_at = now(), bridge_token_id = v_token
   where id = v_dev.id;

  -- The credential is written to the card and then replaced by the device
  -- itself on first contact, exactly like one typed by hand.
  return jsonb_build_object('ok', true, 'serial', v_dev.serial, 'bridge_token', v_secret);
end;
$$;

comment on function public.claim_pi_device(text) is
  'Exchange a one-time claim code for a bridge credential. Called only by the '
  'pi-claim Edge Function — the device is on a bench, not signed in.';

-- Server-only: it mints a working credential from a string, so anything that
-- could reach it could brute-force claim codes. Both revokes are needed — a
-- new function is EXECUTE-to-PUBLIC by default and this project also grants
-- the Data API roles EXECUTE by name.
revoke all on function public.claim_pi_device(text) from public, anon, authenticated;
grant execute on function public.claim_pi_device(text) to service_role;

select p.proname,
       coalesce(pg_catalog.array_to_string(p.proacl, ' | '), '(owner only)') as grants
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('allocate_pi_device', 'claim_pi_device')
order by p.proname;
