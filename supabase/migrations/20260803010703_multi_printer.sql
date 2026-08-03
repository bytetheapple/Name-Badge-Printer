-- Multiple printers. Each has a name, location, IP and port, plus live status.
-- print_jobs and form_entries gain a printer_id. Badge design + label media
-- stay global (in printer_config).

create table public.printers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  location      text,
  printer_ip    text,
  port          int  not null default 9100,
  -- live status, written by the bridge
  reachable     boolean,
  media_type    text,
  media_width   text,
  error_state   text,
  last_checked  timestamptz,
  created_at    timestamptz not null default now()
);
create index printers_created_at_idx on public.printers (created_at);

-- Seed the first printer from the existing single-printer config.
insert into public.printers (name, printer_ip, port)
select 'Main Printer', printer_ip, port from public.printer_config where id = 1;

-- Route jobs and entries to a printer.
alter table public.print_jobs
  add column printer_id uuid references public.printers (id) on delete set null;
alter table public.form_entries
  add column printer_id uuid references public.printers (id) on delete set null;

create index print_jobs_printer_id_idx on public.print_jobs (printer_id);

-- Backfill existing rows to the seeded printer.
update public.print_jobs
  set printer_id = (select id from public.printers order by created_at limit 1)
  where printer_id is null;
update public.form_entries
  set printer_id = (select id from public.printers order by created_at limit 1)
  where printer_id is null;

-- printer_config: IP/port move to printers (label_media + badge_template stay global).
alter table public.printer_config drop column printer_ip;
alter table public.printer_config drop column port;

-- printer_status: per-printer fields move to printers; keep the bridge heartbeat.
alter table public.printer_status drop column printer_reachable;
alter table public.printer_status drop column media_type;
alter table public.printer_status drop column media_width;
alter table public.printer_status drop column error_state;

-- RLS: admins manage printers; anon has no access (form forwards printer_id to
-- the Edge Function, which uses the service_role key).
alter table public.printers enable row level security;
create policy "admins read printers"
  on public.printers for select to authenticated using (true);
create policy "admins insert printers"
  on public.printers for insert to authenticated with check (true);
create policy "admins update printers"
  on public.printers for update to authenticated using (true) with check (true);
create policy "admins delete printers"
  on public.printers for delete to authenticated using (true);

alter publication supabase_realtime add table public.printers;
