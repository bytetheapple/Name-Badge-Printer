-- Track syncing each visitor entry to the ShulCloud "welcome" form.
alter table public.form_entries
  add column shulcloud_sync_status text not null default 'pending'
    check (shulcloud_sync_status in ('pending', 'sent', 'failed', 'skipped')),
  add column shulcloud_error text;
