-- ============================================================================
-- Come back to where the connection was started from
--
-- The callback returns to Integrations because that was the only place a
-- connection could begin. It is about to be startable from Settings — enabling
-- photographs needs an account to put them in — and landing somebody on a
-- different page mid-task reads as the flow having gone wrong.
--
-- Kept in oauth_pending rather than passed through Google and back. Anything
-- that makes the round trip is attacker-controlled by the time we see it, and
-- redirecting to a value from a query string is an open redirect. This value
-- is written by an authenticated owner and read by us; Google never sees it.
--
-- Additive.
-- ============================================================================

alter table public.oauth_pending
  add column if not exists return_to text;

comment on column public.oauth_pending.return_to is
  'Path within the admin console to return to after connecting. Server-side '
  'state, never taken from the callback request — a redirect target that '
  'survives a round trip through a third party is an open redirect.';
