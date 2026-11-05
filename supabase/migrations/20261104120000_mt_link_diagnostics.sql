-- ============================================================================
-- On-demand connectivity diagnostics for an installation.
--
-- Debugging a flaky site (bridge ↔ cloud, bridge ↔ printer, port 9100) meant
-- hand-running ping/nc loops over SSH and reconciling ICMP vs TCP by eye. This
-- lets an operator start a time-boxed diagnostics session on one installation:
-- the bridge then pings the cloud and each printer and TCP-connects each
-- printer's 9100 every few seconds, reporting timestamped samples the ops Link
-- Debug screen draws as a live timeline. It is off by default and auto-stops.
--
-- Two pieces:
--   * printer_status.diagnostics_until — the per-org window (bridge-poll hands
--     it to the bridge; the bridge collects only while now < it).
--   * link_samples — the time-series the bridge writes (service role) and
--     operators read; rolling-pruned to 6 hours in bridge-poll.
--
-- Additive and idempotent.
-- ============================================================================

-- The on-demand window. A plain timestamp on the per-org status row; safe for a
-- tenant to see, operator-only to set (via the RPC below). Null/past = off.
alter table public.printer_status
  add column if not exists diagnostics_until timestamptz;

-- The time-series of link tests. One row per test per tick.
create table if not exists public.link_samples (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  at         timestamptz not null default now(),
  -- 'cloud'        : bridge → Supabase reachability/latency (printer_id null)
  -- 'printer_ping' : bridge → printer ICMP ping
  -- 'printer_tcp'  : bridge → printer TCP connect to the print port (9100)
  kind       text not null check (kind in ('cloud', 'printer_ping', 'printer_tcp')),
  printer_id uuid references public.printers (id) on delete set null,
  ok         boolean not null,
  latency_ms int,
  detail     text
);

create index if not exists link_samples_org_at_idx
  on public.link_samples (org_id, at desc);

-- Operations-only to read, like device_outages: the bridge writes via the
-- service role (bypasses RLS); operators read; tenants get nothing.
alter table public.link_samples enable row level security;
drop policy if exists "platform admins read link_samples" on public.link_samples;
create policy "platform admins read link_samples" on public.link_samples
  for select to authenticated using (public.is_platform_admin());

-- Start a diagnostics window for one org. Operator-only; the is_platform_admin
-- check is the gate, so being callable by authenticated is fine (same posture
-- as delete_organization / list_operators). Clamped to 1..60 minutes.
create or replace function public.start_link_diagnostics(p_org uuid, p_minutes int default 10)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_until timestamptz;
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'only the Guest Badges team can run connectivity diagnostics';
  end if;
  v_until := now() + (greatest(1, least(coalesce(p_minutes, 10), 60)) * interval '1 minute');
  -- printer_status is one row per org (unique org_id). Create it if the bridge
  -- has never checked in, so diagnostics can be armed before first contact.
  insert into public.printer_status (org_id, diagnostics_until)
    values (p_org, v_until)
  on conflict (org_id) do update set diagnostics_until = excluded.diagnostics_until;
  return v_until;
end;
$$;

-- Stop early.
create or replace function public.stop_link_diagnostics(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'only the Guest Badges team can run connectivity diagnostics';
  end if;
  update public.printer_status set diagnostics_until = null where org_id = p_org;
end;
$$;
