-- Let a print job carry its own badge name, so external apps can print via the
-- shared service (the print-badge API) without creating a form_entries row.
-- Our own jobs keep using entry_id; the bridge prefers the job's name when set.
alter table public.print_jobs add column first_name text;
alter table public.print_jobs add column last_name text;
