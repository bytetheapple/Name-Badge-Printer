-- ============================================================================
-- Phase B2 — "scan and add printer"
--
-- The bridge is the only thing that can see printers: they live on the
-- customer's LAN, which neither the Edge Functions (in Supabase's cloud) nor
-- the admin app (HTTPS page, no CORS from the printer) can reach. So the admin
-- asks, the bridge looks, and what it finds comes back through the same
-- bridge-poll channel that carries print jobs.
--
-- Additive and idempotent.
-- ============================================================================

-- What the bridge saw, per organization. Rows are a cache of a scan, not a
-- record of anything — they are safe to delete and will simply reappear.
create table if not exists public.discovered_printers (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  ip         text not null,
  mac        text,
  model      text,
  node_name  text,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  unique (org_id, ip)
);

create index if not exists discovered_printers_org_id_idx
  on public.discovered_printers (org_id, last_seen desc);

alter table public.discovered_printers enable row level security;

-- Anyone who can see the org's printers can see what a scan turned up; adding
-- one is a printer change, so that stays with admins.
drop policy if exists "org read discovered_printers" on public.discovered_printers;
create policy "org read discovered_printers" on public.discovered_printers
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

drop policy if exists "org delete discovered_printers" on public.discovered_printers;
create policy "org delete discovered_printers" on public.discovered_printers
  for delete to authenticated
  using (public.auth_is_org_admin(org_id));

-- Where a scan is asked for. printer_status is already one row per org and is
-- already the bridge's channel for org-wide state, so the request lives there
-- rather than in a table of its own.
alter table public.printer_status
  add column if not exists scan_requested_at timestamptz;

-- Admins ask for a scan by setting that column; the existing update policy on
-- printer_status is read-only for tenants, so grant just this one write.
drop policy if exists "org request printer scan" on public.printer_status;
create policy "org request printer scan" on public.printer_status
  for update to authenticated
  using (public.auth_is_org_admin(org_id))
  with check (public.auth_is_org_admin(org_id));
