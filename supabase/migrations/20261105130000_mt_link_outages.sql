-- ============================================================================
-- Always-on connectivity history for each link, per installation.
--
-- device_outages records when a print *server* dropped off the cloud (one row
-- written when it recovers, from a trigger on pi_devices.last_seen). This does
-- the same for the links *below* that: the bridge → cloud path, and each
-- printer's ICMP ping and TCP 9100. The bridge now probes these continuously
-- (not only during an on-demand Link Debug session) and reports a row when a
-- link *recovers* from an outage — so the ops Connectivity page has a rolling
-- history to look back through, without an operator watching live. An
-- intermittent Wi-Fi fault is exactly the thing you cannot schedule a live
-- session for (Shir Hadash, 2026-11-05).
--
-- Like device_outages: a healthy link writes nothing, and the table is
-- rolling-pruned (to 7 days, in bridge-poll). This is the cheap "transitions,
-- not dense samples" record; link_samples stays the on-demand dense microscope.
--
-- Additive and idempotent.
-- ============================================================================

create table if not exists public.link_outages (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  -- Which printer's link this is; null for the 'cloud' link, which is the
  -- server's own path to Supabase and belongs to no one printer.
  printer_id uuid references public.printers (id) on delete set null,
  -- 'cloud' : bridge → Supabase reachability
  -- 'ping'  : bridge → printer ICMP ping
  -- 'tcp'   : bridge → printer TCP connect to the print port (9100)
  kind       text not null check (kind in ('cloud', 'ping', 'tcp')),
  started_at timestamptz not null,   -- first failed probe of the outage
  ended_at   timestamptz not null,   -- the probe that found it healthy again
  seconds    int not null            -- ended_at - started_at, for cheap sums
);

create index if not exists link_outages_idx
  on public.link_outages (org_id, printer_id, ended_at desc);

-- Operations-only to read, like device_outages / link_samples: the bridge
-- writes via the service role (bypasses RLS); operators read; tenants get
-- nothing.
alter table public.link_outages enable row level security;
drop policy if exists "platform admins read link_outages" on public.link_outages;
create policy "platform admins read link_outages" on public.link_outages
  for select to authenticated using (public.is_platform_admin());
