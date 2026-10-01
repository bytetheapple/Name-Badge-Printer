-- ============================================================================
-- A word printed in the bottom-right of a badge's header.
--
-- Used to mark that a visitor went through the optional external form (the
-- guest waiver) before printing. It is its own slot, separate from corner_note
-- (top-right, "Visitor" / event walk-in), so a badge can carry both.
--
-- Set by submit-badge when the visitor confirms they completed the form; drawn
-- by the bridge. Null on every other badge. Additive and idempotent.
-- ============================================================================

alter table public.print_jobs
  add column if not exists waiver_note text;
