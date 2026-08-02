-- Replace the single `name` column with first_name / last_name to match the
-- Google Form (which has separate fields) and the first-name-forward badge.

alter table public.form_entries add column first_name text;
alter table public.form_entries add column last_name text;

-- Backfill: first token -> first_name, the remainder -> last_name (null if none).
update public.form_entries
set first_name = split_part(name, ' ', 1),
    last_name  = nullif(btrim(substr(name, length(split_part(name, ' ', 1)) + 1)), '');

alter table public.form_entries alter column first_name set not null;
alter table public.form_entries drop column name;
