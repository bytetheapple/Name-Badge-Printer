-- ============================================================================
-- Separate retention windows for photos and driver's licenses.
--
-- photo_retention now governs selfies only; license_retention governs licence
-- images. The retention sweep reads both and deletes each against its own
-- window. New rows default to 'never'; existing rows start licence retention at
-- whatever the combined policy was, so the behaviour in place before this change
-- (one window deleting both) carries over until someone sets them apart.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.app_settings
  add column if not exists license_retention text not null default 'never';

alter table public.app_settings
  drop constraint if exists app_settings_license_retention_check;
alter table public.app_settings
  add constraint app_settings_license_retention_check
    check (license_retention in ('24h', '7d', 'never'));

-- Carry the old combined policy onto licences, once, for rows not yet set.
update public.app_settings
   set license_retention = photo_retention
 where license_retention = 'never';
