-- ============================================================================
-- A greeter marking a guest as checked in (badge handed over / verified).
--
-- Recorded on the entry so it survives a refresh and shows for every greeter at
-- the desk. Greeters cannot write form_entries directly (the role has no table
-- access), so the greeter-checkin Edge Function sets this with the service role
-- after checking the caller's role.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.form_entries
  add column if not exists checked_in_at timestamptz,
  add column if not exists checked_in_by uuid;
