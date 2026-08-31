-- ============================================================================
-- The credential walk cannot run forever
--
-- reissue_pi_device() follows the rotation chain forward from the credential a
-- device was issued, revoking each one. The walk was unbounded, so a cycle in
-- `replaces` — two rows pointing at each other, or one pointing at itself —
-- makes it recurse until the statement times out. Which is exactly what it
-- did, on the first device it was pointed at.
--
-- A rotation should never produce a cycle. But "should never" is not a
-- property of the data, it is a hope about the code that wrote it, and a
-- recursive walk over rows a long-running process has been editing for months
-- needs to terminate whether or not that hope holds.
--
-- Bounded at fifty, which is a century of ninety-day rotations, and a
-- deduplicating UNION so a diamond in the graph cannot double back.
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

  -- Every credential this device has ever held, forward along the rotation
  -- chain. UNION rather than UNION ALL so a row reached twice is visited once,
  -- and a depth cap so a cycle ends the walk instead of the statement timeout
  -- ending it.
  with recursive chain(id, depth) as (
    select t.id, 1
    from public.bridge_tokens t
    where t.id = v_dev.bridge_token_id
    union
    select t.id, c.depth + 1
    from public.bridge_tokens t
    join chain c on t.replaces = c.id
    where c.depth < 50
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
-- A select, not a raise notice. Any of these is a cycle, and the reason the
-- walk needed a bound: a credential that replaces itself, or a pair that
-- replace each other.
select
  (select count(*) from public.bridge_tokens where replaces = id)              as self_referencing,
  (select count(*) from public.bridge_tokens a
     join public.bridge_tokens b on b.id = a.replaces and a.id = b.replaces)   as mutual_pairs;
