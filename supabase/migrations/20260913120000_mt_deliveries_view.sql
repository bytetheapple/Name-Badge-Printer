-- ============================================================================
-- Deliveries, with the name of where they went
--
-- entry_deliveries is readable by anyone in the organization — a greeter who
-- can see a sign-in can see whether it reached the office's systems. But the
-- destination's *name* lives on integrations, which is the owner's, so a plain
-- embed returns rows labelled with nothing but a uuid to everybody else.
--
-- A name is not a credential. This returns the label and the outcome for a
-- batch of sign-ins, to anyone who can already read those sign-ins, and never
-- the config or the secret behind them.
--
-- Batched by entry ids rather than one call per row: the Entries table shows
-- fifty sign-ins with several destinations each, and fifty round trips to
-- render one column is the kind of thing that is fine in testing and awful in
-- a lobby on a Sunday morning.
--
-- Additive and idempotent.
-- ============================================================================

create or replace function public.deliveries_for_entries(p_entries uuid[])
returns table (
  entry_id       uuid,
  integration_id uuid,
  name           text,
  kind           text,
  status         text,
  error          text,
  attempted_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select d.entry_id,
         d.integration_id,
         --: Deleted integrations keep their history; only the label goes.
         coalesce(i.name, '(deleted)'),
         i.kind,
         d.status,
         d.error,
         d.attempted_at
  from public.entry_deliveries d
  left join public.integrations i on i.id = d.integration_id
  where d.entry_id = any (p_entries)
    -- Per row, against the caller's own organizations, exactly as the entries
    -- themselves are.
    and d.org_id in (select public.auth_org_ids())
  order by i.kind, i.name;
$$;

comment on function public.deliveries_for_entries(uuid[]) is
  'Where a batch of sign-ins were sent and what happened, with destination '
  'names. Readable by anyone who can read the sign-ins; never returns an '
  'integration''s config or credential.';

grant execute on function public.deliveries_for_entries(uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice. Empty is the right answer with no auth.uid().
select count(*) as visible_to_anonymous_caller
from public.deliveries_for_entries(
  array(select id from public.form_entries order by created_at desc limit 5));
