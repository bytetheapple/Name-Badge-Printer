-- ============================================================================
-- Minting a bootstrap credential moves to the server
--
-- Issuing a print-server credential was a browser action: generate a secret in
-- the admin, hash it, store the hash. That put a "here is a secret" box in
-- front of a customer who can neither install it nor needs it — the device
-- retires whatever it was given on first contact and renews itself thereafter.
--
-- So the box comes out of the customer's UI, and minting becomes a function
-- only the platform team can call. It belongs to imaging a card, which is our
-- job, and A6's tenant-creation flow is where it resurfaces.
--
-- Additive and idempotent.
-- ============================================================================

-- Randomness without pgcrypto: two UUIDs are ~244 bits of it, which is more
-- than the 256-bit hash downstream can distinguish anyway. gen_random_bytes
-- would read better but drags in an extension this schema does not otherwise
-- need.
create or replace function public.issue_bridge_token(p_org uuid, p_name text default null)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  -- Deliberately not available to an organization's own administrators. A
  -- print server's credential is written when the card is imaged and is
  -- replaced by the device itself on first contact; there is no situation
  -- where a customer needs to mint one, and every situation where being able
  -- to would mean a secret they cannot install.
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'only the Name Badge Kiosk team can issue a print-server credential'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'no such organization';
  end if;

  v_secret := 'nbk_'
    || replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');

  insert into public.bridge_tokens (org_id, name, token_hash, token_prefix)
  values (
    p_org,
    coalesce(nullif(btrim(p_name), ''), 'Print server'),
    encode(sha256(convert_to(v_secret, 'utf8')), 'hex'),
    left(v_secret, 12)
  );

  -- Returned once. Only the hash is kept, so there is no route — here or
  -- anywhere — that can produce this value again.
  return v_secret;
end;
$$;

comment on function public.issue_bridge_token(uuid, text) is
  'Mint a bootstrap credential for a print server and return it once. Platform '
  'admins only. The device replaces it on first contact.';

-- Callable from a signed-in session because it does its own authorization —
-- the same shape as set_provisioning_secret. A6''s console will call it as the
-- platform admin''s own user; until then it is run from the SQL editor.
grant execute on function public.issue_bridge_token(uuid, text) to authenticated, service_role;

-- With minting server-side, nothing in a browser writes a token hash any more.
-- Leaving the insert grant would let an org administrator create a credential
-- for their own org directly, bypassing the check above.
revoke insert on public.bridge_tokens from authenticated;
