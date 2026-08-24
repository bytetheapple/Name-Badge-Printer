-- ============================================================================
-- Phase B2 — tell the admin when a scan has finished
--
-- Without this, "scanning" and "scanned, found nothing" look identical from the
-- admin: it can only watch for rows appearing and give up after a timeout. That
-- makes a genuinely empty result indistinguishable from a bridge that is slow,
-- busy, or not listening — and leaves the previous scan's results on screen
-- while it waits, which is worse than showing nothing.
--
-- The bridge now reports that it scanned, whatever it found, and this records
-- when. Additive and idempotent.
-- ============================================================================

alter table public.printer_status
  add column if not exists scan_completed_at timestamptz;
