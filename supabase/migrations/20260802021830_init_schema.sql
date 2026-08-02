-- Name Badge Printer — initial schema
--
-- Tables: form_entries, print_jobs, printer_config (singleton), printer_status (singleton)
--
-- Security model:
--   * RLS is ON for every table.
--   * anon has NO policies -> no access at all. The public form's writes and the
--     print bridge both use the service_role key, which bypasses RLS.
--   * authenticated users ARE the admins (sign-ups are disabled; admins are
--     invite-only). They can read everything, edit printer_config, and queue
--     reprints / test prints.

-- ---------- helper: keep updated_at fresh on UPDATE ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- form_entries: one row per public submission ----------
create table public.form_entries (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  phone              text,
  email              text,
  source_ip          text,
  google_sync_status text not null default 'pending'
                       check (google_sync_status in ('pending', 'sent', 'failed')),
  google_synced_at   timestamptz,
  google_error       text,
  created_at         timestamptz not null default now()
);

create index form_entries_created_at_idx on public.form_entries (created_at desc);

-- ---------- print_jobs: one row per print request (badge or test) ----------
create table public.print_jobs (
  id         uuid primary key default gen_random_uuid(),
  entry_id   uuid references public.form_entries (id) on delete set null, -- null for test prints
  type       text not null default 'badge' check (type in ('badge', 'test')),
  status     text not null default 'queued'
               check (status in ('queued', 'printing', 'printed', 'failed')),
  attempts   int  not null default 0,
  error      text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  printed_at timestamptz
);

create index print_jobs_status_idx on public.print_jobs (status, created_at);
create index print_jobs_entry_id_idx on public.print_jobs (entry_id);

-- ---------- printer_config: single editable row (id = 1) ----------
create table public.printer_config (
  id             int primary key default 1 check (id = 1),
  printer_ip     text,
  port           int   not null default 9100,
  label_media    text  not null default '62',        -- 62mm continuous DK roll
  dpi            int   not null default 300,          -- QL-820NWB prints at 300 dpi
  badge_template jsonb not null default '{}'::jsonb,  -- layout config; shape defined in Phase 2
  updated_at     timestamptz not null default now()
);

create trigger printer_config_set_updated_at
  before update on public.printer_config
  for each row execute function public.set_updated_at();

-- ---------- printer_status: single row written by the bridge (id = 1) ----------
create table public.printer_status (
  id                int primary key default 1 check (id = 1),
  bridge_last_seen  timestamptz,
  printer_reachable boolean,
  media_type        text,
  media_width       text,
  error_state       text,
  updated_at        timestamptz not null default now()
);

create trigger printer_status_set_updated_at
  before update on public.printer_status
  for each row execute function public.set_updated_at();

-- ---------- seed the singleton rows ----------
insert into public.printer_config (id) values (1) on conflict (id) do nothing;
insert into public.printer_status (id) values (1) on conflict (id) do nothing;

-- ==================== Row-Level Security ====================
alter table public.form_entries   enable row level security;
alter table public.print_jobs     enable row level security;
alter table public.printer_config enable row level security;
alter table public.printer_status enable row level security;

-- Admins (authenticated) can read everything.
create policy "admins read form_entries"
  on public.form_entries for select to authenticated using (true);
create policy "admins read print_jobs"
  on public.print_jobs for select to authenticated using (true);
create policy "admins read printer_config"
  on public.printer_config for select to authenticated using (true);
create policy "admins read printer_status"
  on public.printer_status for select to authenticated using (true);

-- Admins can edit the printer configuration.
create policy "admins update printer_config"
  on public.printer_config for update to authenticated using (true) with check (true);

-- Admins can queue reprints and test prints from the console.
create policy "admins insert print_jobs"
  on public.print_jobs for insert to authenticated with check (type in ('badge', 'test'));

-- Note: no policies for anon -> anon is denied on every table. Public form writes
-- and the bridge use the service_role key (bypasses RLS).

-- ==================== Realtime ====================
-- Enable change broadcasting. RLS still governs which role receives which rows,
-- so this exposes nothing on its own.
alter publication supabase_realtime add table public.form_entries;
alter publication supabase_realtime add table public.print_jobs;
alter publication supabase_realtime add table public.printer_config;
alter publication supabase_realtime add table public.printer_status;
