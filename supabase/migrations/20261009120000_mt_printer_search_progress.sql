-- When the print server is searching for a printer that moved, and its rhythm.
--
-- The bridge re-finds a printer that took a new DHCP address by sweeping for it
-- in the background, on a backoff (bridge/rehome.py). Until now that happened
-- silently: a printer showed "Unreachable" with no sign anything was being done
-- about it. These three timestamps let the console say what is actually going
-- on -- "searching since 9:14, last looked 2 minutes ago, next look in 6" --
-- which turns a dead-looking printer into one visibly being recovered.
--
-- Written every heartbeat alongside `reachable`, and cleared to null the moment
-- the printer answers (the search is over) or when there is nothing to search
-- by. A stale schedule on a printer that has come back is worse than none.
alter table public.printers
  add column if not exists searching_since timestamptz,
  add column if not exists last_search_at  timestamptz,
  add column if not exists next_search_at  timestamptz;

comment on column public.printers.searching_since is
  'When the background search for this moved printer began; null when reachable or not being searched for.';
comment on column public.printers.last_search_at is
  'When the background search last swept for this printer; null if it has not yet, or is not being searched for.';
comment on column public.printers.next_search_at is
  'When the background search will next sweep for this printer; null when reachable or not being searched for.';
