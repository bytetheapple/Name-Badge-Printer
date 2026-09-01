-- ============================================================================
-- Bound the walk by cycles, not by depth
--
-- The depth cap added to reissue_pi_device stopped an infinite walk. It also
-- silently stopped a legitimate one: a device whose credential chain was
-- longer than fifty links had only the first fifty revoked, and the ones left
-- behind were the newest — which are precisely the ones that still work.
--
-- That happened. A device caught in the rotation runaway accumulated well over
-- a hundred credentials; reflashing it revoked fifty and left the live one
-- authenticating on a card that had already been rewritten.
--
-- A cap is the wrong instrument. It cannot tell "this chain is long because
-- something went wrong" from "this chain is long because it loops", and it
-- answers both by doing part of the job and reporting success. Postgres has
-- the right one: CYCLE detects a repeat and stops there, so a chain of any
-- length is walked to its end and a cycle still terminates.
--
-- Additive and idempotent.
-- ============================================================================

create or replace function public.reissue_pi_device(
  p_serial   text,
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

  -- Every credential this device has ever held, however many that is. CYCLE
  -- stops the walk the moment it revisits a row, so a malformed graph ends the
  -- recursion without a cap having to guess how long a real chain can be.
  with recursive chain(id) as (
    select t.id
    from public.bridge_tokens t
    where t.id = v_dev.bridge_token_id
    union all
    select t.id
    from public.bridge_tokens t
    join chain c on t.replaces = c.id
  ) cycle id set is_cycle using path
  update public.bridge_tokens
     set revoked_at = now()
   where id in (select id from chain where not is_cycle)
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
         claimed_at      = null,
         bridge_token_id = null,
         last_seen       = null,
         running_ref     = null,
         update_error    = null
   where id = v_dev.id;

  if v_org is not null then
    perform public.log_activity(v_org, 'device.reissue', v_dev.serial,
      jsonb_build_object('revoked_credentials', v_revoked,
                         'moved', v_dev.org_id is distinct from v_org));
  end if;
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

grant execute on function public.reissue_pi_device(text, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice. Any device that is unclaimed while a
-- credential it once held is still live is one the walk failed to finish.
select count(*) as unclaimed_devices_with_a_live_credential
from public.pi_devices d
join public.bridge_tokens t on t.org_id = d.org_id
where d.claimed_at is null
  and t.revoked_at is null;
