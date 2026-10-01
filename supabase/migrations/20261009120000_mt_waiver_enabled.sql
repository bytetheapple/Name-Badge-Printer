-- ============================================================================
-- An on/off switch for the external-form (waiver) step, separate from its URL,
-- so it can be turned off without clearing the link.
--
-- Seeded on for any org that already has a URL, so behaviour before this change
-- (a populated URL meant the step showed) carries over. public-config returns
-- the URL only when this is on, so the visitor flow needs no change.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.app_settings
  add column if not exists waiver_enabled boolean not null default false;

update public.app_settings
   set waiver_enabled = true
 where coalesce(waiver_url, '') <> '';
