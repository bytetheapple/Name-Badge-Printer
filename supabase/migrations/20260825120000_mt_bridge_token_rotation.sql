-- ============================================================================
-- Bridge credentials rotate themselves
--
-- A3 gave each Pi its own token, but installing one means editing a file on the
-- device. Customers do not have a terminal on their print server and should not
-- need one, which made the "issue a token" box in the admin useless to them —
-- it produced a secret with instructions they could not follow.
--
-- The device is already authenticated and already polls every couple of
-- seconds, so it can be handed a replacement over its own channel. Ordinary
-- refresh-token rollover:
--
--   * the token written at imaging time is retired the first time it is used,
--     so the value a human typed never survives into service
--   * after that it renews on an interval, with nobody clicking anything
--   * a replacement is minted before the old token is revoked, and the old one
--     stays valid until the new one has actually authenticated — so a failed
--     write or a power cut mid-rotation leaves a working device
--
-- Additive and idempotent.
-- ============================================================================

alter table public.bridge_tokens
  --: When this token was first successfully used. Null means it has never
  --: connected, which is what marks a freshly imaged card.
  add column if not exists first_used_at  timestamptz,
  --: When a replacement was minted for this token. It keeps working until the
  --: replacement is used — see revoked_at.
  add column if not exists superseded_at  timestamptz,
  add column if not exists superseded_by  uuid references public.bridge_tokens (id) on delete set null,
  --: The token this one replaced, so a chain can be followed backwards.
  add column if not exists replaces       uuid references public.bridge_tokens (id) on delete set null,
  --: Set when the device could not store a replacement. Rotation backs off
  --: rather than minting a new token on every poll forever.
  add column if not exists rotation_error text,
  add column if not exists rotation_failed_at timestamptz;

comment on column public.bridge_tokens.first_used_at is
  'First successful authentication. Null means never connected; the first '
  'connection triggers the initial rotation, retiring the value typed at '
  'imaging time.';

comment on column public.bridge_tokens.superseded_at is
  'A replacement has been minted. This token still works until the replacement '
  'authenticates — never revoke on issue, only on confirmed use.';

-- Finding the rotation chain, and the sweep below.
create index if not exists bridge_tokens_superseded_idx
  on public.bridge_tokens (superseded_by)
  where superseded_by is not null;

-- The customer never sees a secret again, so let them see what is going on
-- instead: when the credential last renewed, and whether it is failing to.
grant select (first_used_at, superseded_at, rotation_error, rotation_failed_at)
  on public.bridge_tokens to authenticated;

-- Rotation is entirely server-side. No browser writes any of these columns —
-- the grant list from A3 is deliberately not extended.

-- ---------------------------------------------------------------- the sweep
-- Belt and braces for the one case the "revoke on confirmed use" rule does not
-- cover: a device that rotated, stored the new token, and then died before
-- using it. The old token would otherwise stay valid indefinitely.
--
-- Not scheduled — bridge-poll calls it. A tenant with no bridge running has no
-- live tokens to worry about.
create or replace function public.sweep_superseded_bridge_tokens(
  p_grace interval default interval '7 days'
)
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  with done as (
    update public.bridge_tokens
       set revoked_at = now()
     where revoked_at is null
       and superseded_at is not null
       and superseded_at < now() - p_grace
    returning 1
  )
  select count(*)::integer from done;
$$;

-- Server-only: it revokes credentials, and takes an interval that would let a
-- caller revoke every superseded token immediately by passing zero.
--
-- Both revokes are needed. A new function is EXECUTE-to-PUBLIC by default, and
-- this project also grants the Data API roles EXECUTE by name, so dropping
-- either one leaves it callable from the browser. See
-- 20260823170000_mt_fix_function_grants.sql for the time that shipped.
revoke all on function public.sweep_superseded_bridge_tokens(interval)
  from public, anon, authenticated;
grant execute on function public.sweep_superseded_bridge_tokens(interval) to service_role;

-- Verify: must not list anon or authenticated.
select p.proname,
       coalesce(pg_catalog.array_to_string(p.proacl, ' | '), '(owner only)') as grants
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'sweep_superseded_bridge_tokens';
