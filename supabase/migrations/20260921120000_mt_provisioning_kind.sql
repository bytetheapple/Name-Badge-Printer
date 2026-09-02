-- ============================================================================
-- Three things a provisioning session can be
--
-- The walkthrough was written for one job: take a printer out of a box, factory
-- reset it, and put it on a network. Two more jobs turn out to be the same
-- machine with a different starting point.
--
--   setup   what it has always done. Starts at 'reset'.
--
--   rehome  a printer that is already configured and has been carried to a
--           different site. It does not need resetting — resetting it is the
--           one thing that would make the job harder — so it starts at
--           'cable', is matched to the record it already has, and rewrites
--           only its network settings.
--
--   locate  no operator at all. A printer whose address changed and that mDNS
--           could not find is swept for, and its existing record is corrected.
--           This exists because the cheap lookup on the heartbeat deliberately
--           does not sweep: a scan of the customer's network is fine when
--           somebody asked for it and wrong every two seconds forever.
--
-- Keeping them as one table is the point. The lease, the claim, the transcript
-- and the recovery rules are the hard parts and they are already right; a
-- second table would be a second copy of all of it, drifting.
--
-- Additive: existing rows are 'setup', which is what they are.
-- ============================================================================

alter table public.provisioning_sessions
  add column if not exists kind text not null default 'setup';

do $$
begin
  alter table public.provisioning_sessions
    add constraint provisioning_sessions_kind_check
    check (kind in ('setup', 'rehome', 'locate'));
exception
  when duplicate_object then null;
end $$;

comment on column public.provisioning_sessions.kind is
  'setup: a new printer, from the factory reset onwards. rehome: an already '
  'configured printer moved to a different network — no reset, matched to its '
  'existing record by MAC. locate: unattended, sweeps for a printer whose '
  'address changed and corrects its record.';

-- A rehome and a locate both act on a printer that already exists. printer_id
-- has been on this table since the beginning but was only ever written at the
-- end, when a setup created one; these kinds set it at the start and the
-- session updates that row rather than adding another.
comment on column public.provisioning_sessions.printer_id is
  'The printer this session belongs to. Written at the end of a setup, and at '
  'the start of a rehome or locate — which is what stops those creating a '
  'duplicate record for a printer that is merely somewhere else.';

select kind, state, count(*)
  from public.provisioning_sessions
 group by kind, state
 order by kind, state;
