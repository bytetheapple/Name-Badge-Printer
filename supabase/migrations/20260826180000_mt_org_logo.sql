-- ============================================================================
-- An organization's own name mark
--
-- The badge header offers three choices: text, "the logo", or an uploaded
-- image. "The logo" has been a PNG shipped inside the bridge — one
-- congregation's mark, on every deployment. A second organization choosing it
-- would have printed somebody else's name on their badges.
--
-- It becomes an upload, stored per organization beside the other settings that
-- belong to the whole org rather than to one printer.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.app_settings
  add column if not exists logo_url text;

comment on column public.app_settings.logo_url is
  'The organization''s name mark, uploaded in Settings and used by any printer '
  'whose badge_header_mode is ''logo''. Null means that option is not offered.';
