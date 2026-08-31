-- ============================================================================
-- Reflashing a print server, and moving one between customers
--
-- A claim code is single use and a serial is never reused, so until now the
-- only way to reflash a device was to allocate a second one — leaving a dead
-- row in the fleet and a serial that no longer matches the sticker on the case.
-- Reflashing is not an exception: a corrupted card, a returned unit, or a
-- rebuild onto a newer installer all end here.
--
-- The important half is not the new claim code. It is revoking what the old
-- card still holds. Without that, a reflashed Pi and the SD card it replaced
-- both authenticate for the same organization, and the one in a drawer is the
-- one nobody is watching.
--
-- Revoking the credential the device was *issued* is not enough either. It
-- rotates on first contact and roughly every ninety days after, so by now the
-- live credential is several links along a chain from the one recorded against
-- the device. The whole chain goes.
--
-- Additive and idempotent.
-- ============================================================================

create or replace function public.reissue_pi_device(
  p_serial   text,
  --: Null keeps the current organization. Passing a different one moves the
  --: device, which is the same operation: everything it holds stops working
  --: and it has to be claimed again.
  p_org      uuid default null,
  p_customer text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_dev     public.pi_devices%rowtype;
  v_code    text;
  v_org     uuid;
  v_revoked int;
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'only the Guest Badges team can reissue a print server'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_dev from public.pi_devices where serial = btrim(p_serial);
  if not found then
    raise exception 'no print server with the serial %', p_serial;
  end if;

  v_org := coalesce(p_org, v_dev.org_id);
  if v_org is not null and not exists (select 1 from public.organizations where id = v_org) then
    raise exception 'no such organization';
  end if;

  -- Every credential this device has ever held, forward along the rotation
  -- chain from the one it was issued. Revoked, not deleted: the record of what
  -- existed is worth more than the row is worth reclaiming.
  with recursive chain as (
    select t.id from public.bridge_tokens t where t.id = v_dev.bridge_token_id
    union all
    select t.id from public.bridge_tokens t join chain c on t.replaces = c.id
  )
  update public.bridge_tokens
     set revoked_at = now()
   where id in (select id from chain)
     and revoked_at is null;
  get diagnostics v_revoked = row_count;

  v_code := 'gbc_'
    || replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');

  update public.pi_devices
     set org_id       = v_org,
         customer     = coalesce(nullif(btrim(p_customer), ''), customer),
         claim_hash   = encode(sha256(convert_to(v_code, 'utf8')), 'hex'),
         claim_prefix = left(v_code, 12),
         -- Back to unclaimed. The fleet should read "never connected" for a
         -- device that is about to be wiped, rather than showing the last
         -- heartbeat of a card that no longer exists.
         claimed_at      = null,
         bridge_token_id = null,
         last_seen       = null,
         running_ref     = null,
         update_error    = null
   where id = v_dev.id;

  -- On the record for whoever it now belongs to …
  if v_org is not null then
    perform public.log_activity(v_org, 'device.reissue', v_dev.serial,
      jsonb_build_object('revoked_credentials', v_revoked,
                         'moved', v_dev.org_id is distinct from v_org));
  end if;
  -- … and for whoever has just lost it, who would otherwise see a kiosk go
  -- dark with nothing anywhere saying why.
  if v_dev.org_id is not null and v_dev.org_id is distinct from v_org then
    perform public.log_activity(v_dev.org_id, 'device.released', v_dev.serial,
      jsonb_build_object('revoked_credentials', v_revoked));
  end if;

  return jsonb_build_object(
    'serial', v_dev.serial,
    'claim_code', v_code,
    'revoked_credentials', v_revoked);
end;
$$;

comment on function public.reissue_pi_device(text, uuid, text) is
  'Mint a fresh claim code for an existing print server and revoke every '
  'credential it holds, so the card it replaces stops working. Optionally '
  'moves it to another organization. Platform admins only.';

grant execute on function public.reissue_pi_device(text, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice. Any device holding a credential that outlived
-- its claim would be one where this had gone wrong.
select
  (select count(*) from public.pi_devices)                                     as devices,
  (select count(*) from public.pi_devices where claimed_at is null)            as awaiting_claim,
  (select count(*) from public.pi_devices d
     join public.bridge_tokens t on t.id = d.bridge_token_id
    where d.claimed_at is null and t.revoked_at is null)                       as unclaimed_but_live;
