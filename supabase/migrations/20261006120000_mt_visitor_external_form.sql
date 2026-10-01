-- ============================================================================
-- An optional external form in the visitor flow (e.g. an ABC Fitness / GymSales
-- guest waiver).
--
-- When waiver_url is set, the visitor flow adds a step that opens that form in a
-- new tab and then lets the guest come back to print their badge. It is a
-- hand-off, not an integration: a third-party form cannot tell us it was
-- completed, so the guest confirms. The label is what the button and wording
-- call it ("guest waiver"), defaulting to a generic phrase when unset.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.app_settings
  add column if not exists waiver_url   text,
  add column if not exists waiver_label text;
