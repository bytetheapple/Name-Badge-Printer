-- Retry window for failed prints.
--
-- A print that fails used to be marked 'failed' and dropped on the first
-- attempt, so a badge queued to an unreliable printer was lost even though the
-- sign-in record survived. bridge-complete now re-queues a failed job until it
-- is an hour old, so an intermittent printer prints the badge late rather than
-- not at all.
--
-- next_attempt_at is the backoff: bridge-complete sets it when it re-queues,
-- and the claim in bridge-poll skips a job until this time has passed, so a
-- down printer is retried about once a minute instead of every poll. Null
-- (the default, and every freshly created job) means "claim now".
alter table public.print_jobs
  add column if not exists next_attempt_at timestamptz;
