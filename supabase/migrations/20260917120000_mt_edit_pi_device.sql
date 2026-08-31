-- ============================================================================
-- Correcting a print server's description, and undoing a mis-clicked build
--
-- pi_devices has one policy and one grant, both SELECT: nothing writes to that
-- table from a browser, and every change goes through a function that
-- understands what it is changing. That is right for claim_hash and
-- bridge_token_id. It also meant the two fields that are pure description —
-- who it is for, and whatever was jotted down at the bench — could not be
-- corrected at all. A typo was permanent, and "Built for" could only change as
-- a side effect of a reflash, which mints a new claim code and revokes
-- credentials. That is an absurd price for fixing a name.
--
-- Deleting is deliberately narrower: only a device that has never been
-- claimed. Once one has been claimed it has been somewhere and done something,
-- and `customer` exists precisely so that "what did I ship them" outlives an
-- organization that gets renamed or deleted. An unclaimed row has no such
-- history — it is a serial and a code that were never used — so removing a
-- Build clicked by mistake costs nothing.
--
-- Additive and idempotent.
-- ============================================================================

create or replace function public.update_pi_device(
  p_serial   text,
  p_customer text default null,
  p_notes    text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_dev public.pi_devices%rowtype;
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'only the Guest Badges team can edit a print server'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_dev from public.pi_devices where serial = btrim(p_serial);
  if not found then
    raise exception 'no print server with the serial %', p_serial;
  end if;

  -- Only these two. The serial identifies the device, and everything else on
  -- the row is state that the claim, rotation and update paths maintain.
  update public.pi_devices
     set customer = nullif(btrim(coalesce(p_customer, '')), ''),
         notes    = nullif(btrim(coalesce(p_notes, '')), '')
   where id = v_dev.id;

  -- Nothing to say when nothing moved, which keeps a log of real changes
  -- rather than of every time a dialog was opened and closed.
  if coalesce(v_dev.customer, '') is distinct from coalesce(nullif(btrim(coalesce(p_customer, '')), ''), '')
     or coalesce(v_dev.notes, '') is distinct from coalesce(nullif(btrim(coalesce(p_notes, '')), ''), '')
  then
    perform public.log_activity(v_dev.org_id, 'device.edit', v_dev.serial,
      jsonb_build_object('customer', nullif(btrim(coalesce(p_customer, '')), '')));
  end if;
end;
$$;

comment on function public.update_pi_device(text, text, text) is
  'Correct a print server''s customer name and notes. Description only — the '
  'claim, credential and version fields are maintained by the paths that own '
  'them. Platform admins only.';

grant execute on function public.update_pi_device(text, text, text) to authenticated, service_role;

-- ------------------------------------------------------------- undoing a build
create or replace function public.delete_pi_device(p_serial text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_dev public.pi_devices%rowtype;
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'only the Guest Badges team can remove a print server'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_dev from public.pi_devices where serial = btrim(p_serial);
  if not found then
    raise exception 'no print server with the serial %', p_serial;
  end if;

  -- The whole guard. A claimed device has been built, shipped and run, and its
  -- row is the only record of that once an organization is renamed or gone.
  -- Reflashing is how a claimed device is retired, not deletion.
  if v_dev.claimed_at is not null then
    raise exception
      '% has been claimed, so its record is kept. Reflash it instead.', v_dev.serial;
  end if;

  -- Logged before the row goes, and against no organization if it had none.
  perform public.log_activity(v_dev.org_id, 'device.delete', v_dev.serial,
    jsonb_build_object('customer', v_dev.customer));

  delete from public.pi_devices where id = v_dev.id;
end;
$$;

comment on function public.delete_pi_device(text) is
  'Remove a print server that was never claimed — a Build clicked by mistake. '
  'A claimed device is kept: its row is the record of what was shipped.';

grant execute on function public.delete_pi_device(text) to authenticated, service_role;

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice. The second number is what the delete guard
-- protects: rows that could never be removed by it.
select
  (select count(*) from public.pi_devices)                            as devices,
  (select count(*) from public.pi_devices where claimed_at is null)   as removable,
  (select count(*) from public.pi_devices where claimed_at is not null) as kept_for_the_record;
