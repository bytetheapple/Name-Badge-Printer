-- When a print server last checked what version it should run.
--
-- The updater (a systemd timer, separate from the bridge) calls bridge-release
-- about once a minute to ask for its target ref. That call is the only regular
-- signal of the update path's own liveness -- last_seen is bumped by the ~2s
-- job poll, so it says nothing about the once-a-minute update check. Recording
-- the moment of the update check lets the console show a countdown to the next
-- one: an operator who has just set a release can watch it approach the fleet.
alter table public.pi_devices
  add column if not exists last_update_check timestamptz;

comment on column public.pi_devices.last_update_check is
  'When the device last asked bridge-release for its target version (~1/min); distinct from last_seen (the ~2s job poll).';

-- Stamp it on every ask. Same UPDATE that already records running_ref and the
-- update error, so it costs nothing extra and stays exactly as fresh as the
-- check itself.
create or replace function public.bridge_target_ref(
  p_org      uuid,
  p_hostname text,
  p_running  text default null,
  p_error    text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_target text;
begin
  -- Matched on hostname, which is the serial set in Imager. Deliberately not
  -- on the bridge token: that is replaced every time the credential rotates,
  -- and a link through it would break on the first renewal.
  update public.pi_devices
     set running_ref       = coalesce(nullif(btrim(p_running), ''), running_ref),
         last_seen         = now(),
         last_update_check = now(),
         update_error      = nullif(btrim(p_error), '')
   where serial = btrim(p_hostname)
     and (org_id = p_org or org_id is null);

  select coalesce(
           (select pinned_ref from public.pi_devices
             where serial = btrim(p_hostname) and pinned_ref is not null),
           (select ref from public.bridge_release where id)
         )
    into v_target;

  return jsonb_build_object('ref', v_target);
end;
$$;
