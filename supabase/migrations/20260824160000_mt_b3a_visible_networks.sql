-- ============================================================================
-- Phase B3a — let the printer name the networks it can actually see
--
-- Typing an SSID by hand invites two mistakes that both cost a factory reset:
-- a typo, and choosing a 5GHz network. This printer is 2.4GHz only, so a list
-- it produced itself cannot contain a network it is unable to join — which is
-- not true of a list from any other device on the site.
--
-- Its own web UI does the survey (the Browse button on the wireless page), and
-- it answers over Ethernet before any wireless is configured, so the list can
-- be collected during the configure step and shown when the operator is asked
-- to choose.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.provisioning_sessions
  add column if not exists visible_networks jsonb not null default '[]'::jsonb;

comment on column public.provisioning_sessions.visible_networks is
  'SSIDs the printer itself reported seeing, collected during the configure '
  'step. Advisory only: the operator can still name a network that is not '
  'listed, since a printer is often set up somewhere other than where it will '
  'live.';
