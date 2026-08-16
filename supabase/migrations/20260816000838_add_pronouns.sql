-- Optional pronouns: a toggle in the admin, a value on each entry/job, printed
-- under the name when provided.
alter table public.app_settings add column pronouns_enabled boolean not null default false;
alter table public.form_entries add column pronouns text;
alter table public.print_jobs add column pronouns text;
