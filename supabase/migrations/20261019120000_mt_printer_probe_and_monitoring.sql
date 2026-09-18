-- On-demand "Test connection" for a printer, and a per-server "monitoring since"
-- for the connectivity graph.

-- 1. A test-connection request. The console sets this to now(); the bridge sees
--    it on its next poll and probes the printer there and then, out of the 15s
--    heartbeat, so the button gets a real answer in a couple of seconds. It is
--    self-clearing: the bridge acts only while probe_requested_at is newer than
--    last_checked, and its probe advances last_checked past it.
alter table public.printers
  add column if not exists probe_requested_at timestamptz;

-- 2. When we began recording a print server's connectivity. Before it, the graph
--    has no data and should paint grey rather than an assumed green. Existing
--    servers start now — we cannot recover when recording actually began — so
--    their graphs go grey up to now and fill in from here. A server built later
--    is anchored at its first check-in by the outage trigger below.
alter table public.pi_devices
  add column if not exists monitoring_since timestamptz;

update public.pi_devices set monitoring_since = now() where monitoring_since is null;

-- Fold the anchor into the existing outage trigger: a new device gets its
-- monitoring_since on the first last_seen update (its first poll), and every
-- device keeps recording outages exactly as before.
create or replace function public.record_device_outage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.monitoring_since is null then
    NEW.monitoring_since := now();
  end if;
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
    delete from public.device_outages
     where device_id = NEW.id
       and ended_at < now() - interval '7 days';
  end if;
  return NEW;
end;
$$;
