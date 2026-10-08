-- ============================================================================
-- The prohibited-visitors list: a Google Sheet of people barred from the
-- facility, matched against guest sign-ins so the greeter desk is warned.
--
-- A new integration kind. The owner creates it (a spreadsheet in the org's
-- Drive with First name / Last name / Driver's license number / Birthdate
-- columns) and fills it; the greeter-feed function matches sign-ins against it
-- by name and flags a match for the greeter to verify.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.integrations drop constraint if exists integrations_kind_check;
alter table public.integrations add constraint integrations_kind_check
  check (kind in ('google_form', 'shulcloud', 'google_drive', 'google_sheet',
                  'google_oauth', 'event', 'prohibited'));
