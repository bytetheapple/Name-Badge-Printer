-- ============================================================================
-- The fleet-wide firmware record stops carrying customer text
--
-- firmware_observations has no org_id: one row per (model, firmware), read by
-- platform admins across every customer. That is right for what it is for —
-- "does this step fail on this firmware?" is a fact about a build, not about
-- an organization.
--
-- But last_error was written from the provisioning error message, and that
-- message quotes up to 200 characters of the printer's own web page. A page
-- that can carry the customer's network name. So one org's incidental data
-- was landing in a table deliberately not scoped to them.
--
-- The bridge now sends a classification from a fixed vocabulary instead
-- (login_page, no_form, unreachable, rejected), and the Edge Function drops
-- anything outside it. The full text still goes to the session log, which is
-- scoped to the org that owns it.
--
-- Additive except for the clear-out below, which is deliberate.
-- ============================================================================

comment on column public.firmware_observations.last_error is
  'Why the last failure happened, from a fixed vocabulary: login_page, '
  'no_form, unreachable, rejected. Never free text — this table is fleet-wide '
  'and has no org_id, so anything quoted from a customer''s printer would sit '
  'outside their organization. The full message lives on the provisioning '
  'session, which is org-scoped.';

-- Clears text captured under the old behaviour.
--
-- THIS DISCARDS DATA: any last_error already recorded is free text from a
-- customer's printer, which is the thing being removed. The counters,
-- failed_steps and timestamps — everything actually used to judge a firmware —
-- are untouched.
update public.firmware_observations
   set last_error = null
 where last_error is not null
   and last_error not in ('login_page', 'no_form', 'unreachable', 'rejected');

select model, firmware, failures, last_error
  from public.firmware_observations
 order by model, firmware;
