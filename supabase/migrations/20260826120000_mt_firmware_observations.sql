-- ============================================================================
-- What firmware we have actually configured, across the whole fleet
--
-- printer_config.py carries FIRMWARE_VERIFIED = "1.32", the version the field
-- names were read off. Everything else gets a warning, whether it works
-- perfectly or not at all, because nothing records which.
--
-- This is that record: one row per model and firmware, counting how often
-- configuration succeeded and failed, and which steps did the failing. It is
-- deliberately fleet-wide and carries no organization — a firmware version is
-- a property of the hardware, not of the congregation that bought it, and
-- keeping the two apart means this table can be read without reading anyone's
-- tenant data.
--
-- Additive and idempotent.
-- ============================================================================

create table if not exists public.firmware_observations (
  model      text not null,
  firmware   text not null,
  attempts   integer not null default 0,
  successes  integer not null default 0,
  failures   integer not null default 0,
  --: Step name -> how many times it failed on this firmware. The actionable
  --: part: a field name that moved between versions shows up here as one step
  --: failing consistently while the rest pass.
  failed_steps jsonb not null default '{}'::jsonb,
  last_error text,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (model, firmware)
);

alter table public.firmware_observations enable row level security;

-- Platform admins only. Not secret, but it describes hardware belonging to
-- every customer, and an organization has no use for another's fleet.
drop policy if exists "platform admins read firmware" on public.firmware_observations;
create policy "platform admins read firmware" on public.firmware_observations
  for select to authenticated
  using (public.is_platform_admin());

-- This project grants the Data API roles full access to new tables, so the
-- policy above is only half the job — without the revoke, `authenticated`
-- keeps a blanket grant that RLS then filters, and every write path is open.
revoke all on public.firmware_observations from anon, authenticated;
grant select on public.firmware_observations to authenticated;

-- ---------------------------------------------------------------- recording
create or replace function public.record_firmware_observation(
  p_model    text,
  p_firmware text,
  p_ok       boolean,
  p_failed_steps text[] default '{}',
  p_error    text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_steps jsonb := '{}'::jsonb;
  v_step  text;
begin
  if p_model is null or btrim(p_model) = '' then return; end if;
  if p_firmware is null or btrim(p_firmware) = '' then return; end if;

  foreach v_step in array coalesce(p_failed_steps, '{}') loop
    v_steps := jsonb_set(v_steps, array[v_step],
                         to_jsonb(coalesce((v_steps ->> v_step)::int, 0) + 1));
  end loop;

  insert into public.firmware_observations as f
    (model, firmware, attempts, successes, failures, failed_steps, last_error)
  values (
    btrim(p_model), btrim(p_firmware), 1,
    case when p_ok then 1 else 0 end,
    case when p_ok then 0 else 1 end,
    v_steps,
    case when p_ok then null else left(p_error, 500) end
  )
  on conflict (model, firmware) do update set
    attempts  = f.attempts + 1,
    successes = f.successes + case when p_ok then 1 else 0 end,
    failures  = f.failures  + case when p_ok then 0 else 1 end,
    -- Merge the per-step counts rather than replacing them.
    failed_steps = (
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
      from (
        select key, sum(value::int) as value
        from (
          select * from jsonb_each_text(f.failed_steps)
          union all
          select * from jsonb_each_text(v_steps)
        ) both_ways
        group by key
      ) merged
    ),
    -- Keep the most recent failure, but do not let a success erase it: the
    -- last thing that went wrong is what someone will want to see.
    last_error = case when p_ok then f.last_error else left(p_error, 500) end,
    last_seen = now();
end;
$$;

comment on function public.record_firmware_observation(text, text, boolean, text[], text) is
  'Record one configuration attempt against a model and firmware version. '
  'Called by bridge-poll. Only outcomes attributable to the configuration '
  'itself are recorded — a refused password or an unreachable printer says '
  'nothing about firmware and must not be counted as a failure.';

-- Server-only: it writes fleet-wide counters from arguments the caller chooses.
-- Both revokes are needed — a new function is EXECUTE-to-PUBLIC by default,
-- and this project also grants the Data API roles EXECUTE by name.
revoke all on function public.record_firmware_observation(text, text, boolean, text[], text)
  from public, anon, authenticated;
grant execute on function public.record_firmware_observation(text, text, boolean, text[], text)
  to service_role;

select p.proname,
       coalesce(pg_catalog.array_to_string(p.proacl, ' | '), '(owner only)') as grants
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'record_firmware_observation';
