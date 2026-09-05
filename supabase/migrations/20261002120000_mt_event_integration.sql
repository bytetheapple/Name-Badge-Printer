-- Event integrations: a registration desk, not a sign-in kiosk.
--
-- An organization holding an event has a list of people who registered in
-- advance. Everyone who prints a badge is matched against that list: a match
-- is checked off, and anyone not on it is added to an On-site registration tab
-- in the same spreadsheet. On-site badges carry the word ON-SITE so the desk
-- can tell them apart, often to collect payment before handing one over.
--
-- Each event has one or more QR codes, one per printer, so a queue can be
-- split across desks. On-site registrations may be routed to a printer of
-- their own -- typically behind the desk -- whichever code was scanned.

alter table public.integrations drop constraint if exists integrations_kind_check;
alter table public.integrations add constraint integrations_kind_check
  check (kind in ('google_form', 'shulcloud', 'google_drive', 'google_sheet',
                  'google_oauth', 'event'));

-- ------------------------------------------------------------ the QR codes
-- One row per printer taking part in one event. The token is what a printed
-- QR code carries, so it is per printer and per event: retiring one code must
-- not disturb the others, and a code printed for last year's event must not
-- open this year's.
create table if not exists public.event_printers (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  integration_id uuid not null references public.integrations (id) on delete cascade,
  printer_id     uuid not null references public.printers (id) on delete cascade,

  -- Opaque, like a kiosk token. Rotatable without touching the event.
  token          text not null unique,

  created_at     timestamptz not null default now(),

  -- A printer appears once per event. Two codes for the same printer at the
  -- same event would be indistinguishable on paper.
  unique (integration_id, printer_id)
);

create index if not exists event_printers_integration_idx
  on public.event_printers (integration_id);

alter table public.event_printers enable row level security;

drop policy if exists "org admin read event printers" on public.event_printers;
create policy "org admin read event printers" on public.event_printers
  for select to authenticated using (public.auth_is_org_admin(org_id));

drop policy if exists "org admin write event printers" on public.event_printers;
create policy "org admin write event printers" on public.event_printers
  for insert to authenticated with check (public.auth_is_org_admin(org_id));

drop policy if exists "org admin update event printers" on public.event_printers;
create policy "org admin update event printers" on public.event_printers
  for update to authenticated using (public.auth_is_org_admin(org_id))
  with check (public.auth_is_org_admin(org_id));

drop policy if exists "org admin delete event printers" on public.event_printers;
create policy "org admin delete event printers" on public.event_printers
  for delete to authenticated using (public.auth_is_org_admin(org_id));

grant select, insert, update, delete on public.event_printers to authenticated;

-- --------------------------------------------------------------- the badge
-- A word in the corner of the header band. Used for ON-SITE, and deliberately
-- free text rather than a flag: the corner already exists for "Visitor", and
-- one slot that carries whatever word applies beats a second slot per case.
alter table public.print_jobs
  add column if not exists corner_note text;

comment on column public.print_jobs.corner_note is
  'Short word printed in the corner of the badge header, e.g. ON-SITE. Null for an ordinary badge.';

-- Which event a sign-in came through, so an entry can be traced back to the
-- desk it was taken at. Null for the ordinary kiosk form.
alter table public.form_entries
  add column if not exists event_integration_id uuid
    references public.integrations (id) on delete set null;

comment on column public.form_entries.event_integration_id is
  'The Event integration this registration came through; null for the ordinary sign-in form.';
