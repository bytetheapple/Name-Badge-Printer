-- Member vs Visitor classification. Both are recorded and printed, but only
-- visitors are submitted to the Google Form (members get 'skipped').

alter table public.form_entries
  add column visitor_type text not null default 'visitor'
    check (visitor_type in ('member', 'visitor'));

-- Allow marking Google sync as intentionally skipped (for members).
alter table public.form_entries
  drop constraint form_entries_google_sync_status_check;
alter table public.form_entries
  add constraint form_entries_google_sync_status_check
    check (google_sync_status in ('pending', 'sent', 'failed', 'skipped'));
