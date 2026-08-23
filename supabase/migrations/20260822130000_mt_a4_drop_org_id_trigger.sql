-- ============================================================================
-- Multi-tenant Phase A4 — retire the transitional org_id trigger
--
-- APPLY THIS LAST, and only once the A4 Edge Functions and app are deployed and
-- a real sign-in has been shown to work. Until then the trigger is what keeps
-- the old, unstamped writers alive.
--
-- A1 added set_org_id_default() so that writers which did not yet know about
-- organizations could still insert. Every writer now derives org_id from a
-- trusted source of its own:
--
--   public sign-in      -> the kiosk token (or the legacy printer id)
--   external print API  -> the api_keys row behind x-api-key
--   print bridge        -> its bridge token
--   admin portal        -> the selected org, checked by RLS
--
-- With the trigger gone, an insert that fails to say which tenant it belongs to
-- is rejected outright instead of being quietly filed somewhere. That is the
-- point: it removes the last path by which a row could land in the wrong org,
-- and it is what unblocks onboarding a second congregation.
--
-- TO REVERSE (if a writer was missed and inserts start failing):
--   create trigger form_entries_set_org_id before insert on public.form_entries
--     for each row execute function public.set_org_id_default();
--   -- …and the same for print_jobs, printers, printer_config, printer_status,
--   -- app_settings. Keep the functions below in place if you may need this.
-- ============================================================================

drop trigger if exists form_entries_set_org_id   on public.form_entries;
drop trigger if exists print_jobs_set_org_id     on public.print_jobs;
drop trigger if exists printers_set_org_id       on public.printers;
drop trigger if exists printer_config_set_org_id on public.printer_config;
drop trigger if exists printer_status_set_org_id on public.printer_status;
drop trigger if exists app_settings_set_org_id   on public.app_settings;

drop function if exists public.set_org_id_default();
drop function if exists public.default_org_id();
