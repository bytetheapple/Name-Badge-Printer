-- ============================================================================
-- Driver's-license capture for visitors — a sibling of the selfie.
--
-- Same shape as selfie_mode, and it writes to the same connected Google account,
-- but into its own folder (license_drive_folder_id) so the two never mix. The
-- status lives on the entry only, not in the deliveries table: a licence shares
-- the google_drive destination with the selfie, and record_delivery is keyed on
-- (entry, integration), so recording both there would overwrite one with the
-- other. Keeping it on the entry also keeps the link out of the Google Sheet and
-- the general delivery pills — a licence image is more sensitive than a selfie.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.app_settings
  add column if not exists license_mode text not null default 'off',
  add column if not exists license_drive_folder_id text;

alter table public.app_settings
  drop constraint if exists app_settings_license_mode_check;
alter table public.app_settings
  add constraint app_settings_license_mode_check
    check (license_mode in ('off', 'optional', 'required'));

alter table public.form_entries
  add column if not exists license_link text,
  add column if not exists license_status text not null default 'skipped',
  add column if not exists license_error text;

alter table public.form_entries
  drop constraint if exists form_entries_license_status_check;
alter table public.form_entries
  add constraint form_entries_license_status_check
    check (license_status in ('pending', 'sent', 'failed', 'skipped'));

comment on column public.form_entries.license_status is
  '''skipped'' means no licence image reached us — not asked for, declined, or '
  'the upload never arrived. ''failed'' means it arrived and could not be '
  'stored, and license_error says why.';

-- Anything already stored was a success (there is none yet, but mirror selfie).
update public.form_entries
   set license_status = 'sent'
 where license_link is not null
   and license_status <> 'sent';
