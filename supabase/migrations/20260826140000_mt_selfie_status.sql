-- ============================================================================
-- A failed selfie upload leaves a trace
--
-- Google and ShulCloud each record a status and an error on the entry. Selfies
-- recorded only success, as selfie_link — so a failed upload wrote nothing
-- anywhere. The kiosk calls that function fire-and-forget with an empty catch,
-- deliberately, because a photo must never hold up a badge; the consequence was
-- that the visitor saw a normal badge, the admin saw nothing, and the only
-- record was an Edge Function log whose three config-failure paths do not log.
--
-- Found because someone happened to be testing. A congregation that switched
-- selfies on would simply have got no photos and no reason to suspect it.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.form_entries
  add column if not exists selfie_status text not null default 'skipped',
  add column if not exists selfie_error text;

-- Default 'skipped', not 'pending': most sign-ins never involve a photo, and a
-- pending pill on every member would be noise rather than information.
alter table public.form_entries
  drop constraint if exists form_entries_selfie_status_check;
alter table public.form_entries
  add constraint form_entries_selfie_status_check
    check (selfie_status in ('pending', 'sent', 'failed', 'skipped'));

comment on column public.form_entries.selfie_status is
  '''skipped'' means no photo reached us — not asked for, declined, or the '
  'upload request never arrived. ''failed'' means it arrived and could not be '
  'stored, and selfie_error says why.';

-- Anything already in Drive was a success.
update public.form_entries
   set selfie_status = 'sent'
 where selfie_link is not null
   and selfie_status <> 'sent';
