-- ============================================================================
-- The printer's code is asked for once a printer has been chosen
--
-- The setup form asked for it up front, before anything had been discovered.
-- That is the wrong moment twice over: nobody knows yet which printer they are
-- setting up, and each printer has a different code on its own label — so the
-- value entered was, in the field, the code for a printer other than the one
-- the wizard went on to talk to.
--
-- A new operator step sits between choosing a printer and configuring it, and
-- a failed login returns to it rather than to the choice.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.provisioning_sessions
  drop constraint if exists provisioning_sessions_state_check;

alter table public.provisioning_sessions
  add constraint provisioning_sessions_state_check check (state in (
    -- waiting on the person at the printer
    'reset', 'first_run', 'cable', 'select', 'password', 'wifi_confirm',
    'power_cycle',
    -- waiting on the bridge
    'discover', 'configure', 'wifi', 'rediscover',
    -- terminal
    'done', 'failed'
  ));
