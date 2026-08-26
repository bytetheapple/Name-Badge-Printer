-- ============================================================================
-- Pinning a device, from the console rather than the SQL editor
--
-- pinned_ref was added with the release mechanism and had no way to set it:
-- pi_devices grants only select to the browser, so holding one device back —
-- the thing that makes a staged rollout possible — was a hand-written update.
--
-- That is the gap A6 exists to close, so this closes it.
--
-- Additive and idempotent.
-- ============================================================================

create or replace function public.pin_pi_device(p_serial text, p_ref text default null)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'only the Name Badge Kiosk team can pin a print server'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.pi_devices where serial = btrim(p_serial)) then
    raise exception 'no such print server';
  end if;

  -- The same shape the updater will accept, checked here so a typo is refused
  -- at the moment it is made rather than fifteen minutes later on a device in
  -- somebody's building. The leading hyphen is separate: "--upload-pack" is
  -- all legal characters and is read by git as an option.
  if p_ref is not null and btrim(p_ref) <> '' then
    if btrim(p_ref) ~ '^-' or btrim(p_ref) !~ '^[A-Za-z0-9._/-]+$' then
      raise exception 'that does not look like a commit or tag: %', p_ref;
    end if;
  end if;

  update public.pi_devices
     set pinned_ref = nullif(btrim(coalesce(p_ref, '')), '')
   where serial = btrim(p_serial);
end;
$$;

comment on function public.pin_pi_device(text, text) is
  'Hold one print server on a named version, or unpin it with null. A pin '
  'beats the fleet release, which is what makes a staged rollout possible.';

grant execute on function public.pin_pi_device(text, text) to authenticated, service_role;
