-- ============================================================================
-- Managed bridge updates
--
-- Updating a print server meant someone opening a shell on it and typing git
-- pull. That does not survive a fleet, and it means a device in a locked
-- building runs whatever it was built with for ever.
--
-- Auto-pulling `main` is not the answer either: main is a working trunk, and a
-- stray push would become a fleet-wide deploy within minutes.
--
-- So the server names a version and devices converge to it. Releasing is a row
-- change, not a git operation — which makes rollback instant, lets a rollout
-- be staged one device at a time, and lets a customer be held on a known-good
-- version while something is fixed.
--
-- Additive and idempotent.
-- ============================================================================

-- One row. A table rather than a constant so that changing it is an ordinary
-- write with an ordinary audit trail, and so a future channel (beta, stable)
-- is another row rather than a migration.
create table if not exists public.bridge_release (
  id         boolean primary key default true check (id),
  --: A commit sha or tag in the bridge repository. Null means "do not update"
  --: — devices stay where they are, which is the safe reading of "unset".
  ref        text,
  notes      text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

insert into public.bridge_release (id, ref, notes)
values (true, null, 'No release set: devices stay on whatever they were built with.')
on conflict (id) do nothing;

alter table public.bridge_release enable row level security;

drop policy if exists "platform admins read release" on public.bridge_release;
create policy "platform admins read release" on public.bridge_release
  for select to authenticated using (public.is_platform_admin());

drop policy if exists "platform admins set release" on public.bridge_release;
create policy "platform admins set release" on public.bridge_release
  for update to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

revoke all on public.bridge_release from anon, authenticated;
grant select, update on public.bridge_release to authenticated;

-- What each device is on, and whether it is held back.
alter table public.pi_devices
  --: Overrides the fleet release for this one device. The staged-rollout and
  --: hold-a-customer-back mechanism, and the same field for both.
  add column if not exists pinned_ref text,
  --: What the device last reported running. Reported, never assumed — a device
  --: that failed to update and rolled back says so here.
  add column if not exists running_ref text,
  add column if not exists last_seen timestamptz,
  --: Set when an update was attempted and did not take. The device reverts
  --: itself; this is how anyone finds out.
  add column if not exists update_error text;

comment on column public.pi_devices.pinned_ref is
  'Overrides the fleet release for this device. Used to try a release on one '
  'device first, and to hold a customer on a known-good version.';

-- ------------------------------------------------- what a device should run
-- Called by the updater on the device, through an Edge Function. Records what
-- it reported and answers with what it should be on.
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
     set running_ref  = coalesce(nullif(btrim(p_running), ''), running_ref),
         last_seen    = now(),
         update_error = nullif(btrim(p_error), '')
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

comment on function public.bridge_target_ref(uuid, text, text, text) is
  'What this device should be running, and a note of what it says it is. '
  'A device pin wins over the fleet release; null means do not update.';

-- Server-only: it is reached through an Edge Function that has already
-- authenticated the device's bridge credential. Both revokes are needed.
revoke all on function public.bridge_target_ref(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.bridge_target_ref(uuid, text, text, text) to service_role;

select p.proname,
       coalesce(pg_catalog.array_to_string(p.proacl, ' | '), '(owner only)') as grants
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'bridge_target_ref';
