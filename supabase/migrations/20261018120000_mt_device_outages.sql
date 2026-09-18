-- A rolling 7-day record of when each print server was disconnected.
--
-- The "server offline" flag on the console is a 15-second freshness heuristic:
-- it flickers, and a point-in-time flag cannot tell a real outage from a brief
-- lapse while the bridge was busy printing or its poll was slow. To see the
-- actual history -- how often a server dropped and for how long -- we need to
-- record it.
--
-- The signal is pi_devices.last_seen, which bridge-poll stamps on every poll
-- (~2s) and the updater on every check (~60s). A healthy server keeps it fresh;
-- a real outage is a gap where NEITHER updated it. So a trigger watches for a
-- jump in last_seen larger than the threshold and records the gap it just
-- recovered from -- the exact [was-last-seen, now] interval, captured at
-- reconnect. No sampler and no cron: an outage writes exactly one row, when it
-- ends.
--
-- The threshold (2 minutes) is deliberately above the updater's ~60s cadence,
-- so the updater checking in never reads as a drop, and below anything a person
-- would call a real outage. An outage still in progress is not here yet -- it
-- has not ended -- so the console derives the current gap from last_seen itself.
create table public.device_outages (
  id         uuid primary key default gen_random_uuid(),
  device_id  uuid not null references public.pi_devices (id) on delete cascade,
  started_at timestamptz not null,   -- the last poll before it went quiet
  ended_at   timestamptz not null,   -- the poll that brought it back
  seconds    int not null            -- ended_at - started_at, for cheap sums
);

create index device_outages_device_idx
  on public.device_outages (device_id, ended_at desc);

alter table public.device_outages enable row level security;

-- Operations-only, like the fleet it describes.
drop policy if exists "platform admins read device_outages" on public.device_outages;
create policy "platform admins read device_outages" on public.device_outages
  for select to authenticated using (public.is_platform_admin());

create or replace function public.record_device_outage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if OLD.last_seen is not null
     and NEW.last_seen is not null
     and NEW.last_seen > OLD.last_seen + interval '2 minutes' then
    insert into public.device_outages (device_id, started_at, ended_at, seconds)
    values (
      NEW.id,
      OLD.last_seen,
      NEW.last_seen,
      floor(extract(epoch from (NEW.last_seen - OLD.last_seen)))::int
    );
    -- Keep it rolling: whenever a device records a new outage, drop that
    -- device's outages older than a week. A perfectly stable device writes
    -- nothing and needs no pruning.
    delete from public.device_outages
     where device_id = NEW.id
       and ended_at < now() - interval '7 days';
  end if;
  return NEW;
end;
$$;

drop trigger if exists pi_devices_record_outage on public.pi_devices;
create trigger pi_devices_record_outage
  before update of last_seen on public.pi_devices
  for each row
  execute function public.record_device_outage();
