-- ============================================================================
-- Retention policy for visitor images (selfies and driver's licenses).
--
-- One policy per organization — delete stored images after 24h, after 7 days,
-- or never. Enforced by an hourly scheduled sweep (pg_cron -> pg_net -> the
-- retention-sweep Edge Function), which deletes the Drive files and clears the
-- links. To delete a Drive file you need its id, not the view link we showed in
-- the admin, so the id is now recorded alongside the link at upload time.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.app_settings
  add column if not exists photo_retention text not null default 'never';

alter table public.app_settings
  drop constraint if exists app_settings_photo_retention_check;
alter table public.app_settings
  add constraint app_settings_photo_retention_check
    check (photo_retention in ('24h', '7d', 'never'));

-- The Drive file ids, so the sweep can delete what the links only point at.
alter table public.form_entries
  add column if not exists selfie_file_id text,
  add column if not exists license_file_id text;

-- A fourth outcome for an image that was stored and then removed by policy, so
-- the admin sees "Deleted" rather than a blank where a photo used to be.
alter table public.form_entries
  drop constraint if exists form_entries_selfie_status_check;
alter table public.form_entries
  add constraint form_entries_selfie_status_check
    check (selfie_status in ('pending', 'sent', 'failed', 'skipped', 'deleted'));

alter table public.form_entries
  drop constraint if exists form_entries_license_status_check;
alter table public.form_entries
  add constraint form_entries_license_status_check
    check (license_status in ('pending', 'sent', 'failed', 'skipped', 'deleted'));

-- Narrow index for the sweep: only rows that still have a file to delete.
create index if not exists form_entries_retention_idx
  on public.form_entries (org_id, created_at)
  where selfie_file_id is not null or license_file_id is not null;

-- ---------------------------------------------------------------------------
-- The schedule. pg_cron runs the job; pg_net makes the HTTPS call to the Edge
-- Function, which does the Drive deletions. The service-role key it calls with
-- is read from Vault (secret name 'service_role_key') so it is not written into
-- the job definition — store it once with the snippet in the deploy notes.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace any earlier copy of this job, so re-running the migration is safe.
select cron.unschedule('photo-retention-sweep')
 where exists (select 1 from cron.job where jobname = 'photo-retention-sweep');

select cron.schedule(
  'photo-retention-sweep',
  '7 * * * *',  -- hourly, at seven past
  $cron$
  select net.http_post(
    url := 'https://xesgdkwwhszdtcgcdjjw.supabase.co/functions/v1/retention-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
        ''
      )
    ),
    body := '{}'::jsonb
  );
  $cron$
);
