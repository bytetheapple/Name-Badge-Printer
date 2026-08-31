-- ============================================================================
-- Where one sign-in should be sent
--
-- The question every sync path now asks, answered once in SQL rather than
-- rebuilt in three Edge Functions that would drift apart. It resolves the
-- entry's printer, applies that printer's exceptions over each integration's
-- default, and hands back the config and the decrypted credential for every
-- destination that survives.
--
-- An entry with no printer — one printed through the API, or a family member
-- row that carries no kiosk — has no per-printer exceptions to apply, so it
-- follows every integration's default. The left join gives that for free
-- rather than needing a branch.
--
-- Same handling of EXECUTE as integration_for: this returns a decrypted
-- credential, so no browser role may hold it, and revoking from PUBLIC is not
-- enough on its own because this project grants the Data API roles EXECUTE on
-- new functions.
--
-- Additive and idempotent.
-- ============================================================================

create or replace function public.integration_targets(p_entry uuid, p_kind text)
returns table (id uuid, name text, config jsonb, secret text)
language sql
stable
security definer
set search_path = public
as $$
  select i.id,
         i.name,
         i.config,
         (select s.decrypted_secret from vault.decrypted_secrets s where s.id = i.secret_id)
  from public.form_entries e
  join public.integrations i
    on i.org_id = e.org_id
   and i.kind = p_kind
   and i.enabled
  left join public.printer_integrations pi
    on pi.integration_id = i.id
   and pi.printer_id = e.printer_id
  where e.id = p_entry
    and coalesce(pi.enabled, i.default_enabled)
  order by i.name;
$$;

comment on function public.integration_targets(uuid, text) is
  'Every destination of one kind that a given sign-in should be sent to, with '
  'its credential. Applies the entry''s printer exceptions over each '
  'integration''s default; an entry with no printer follows the defaults.';

revoke all on function public.integration_targets(uuid, text)
  from public, anon, authenticated;
grant execute on function public.integration_targets(uuid, text) to service_role;

-- ------------------------------------------------------- recording a result
-- Upsert, so a retry updates the attempt rather than adding a second row, and
-- so the unique index on (entry_id, integration_id) is what keeps the history
-- one-row-per-destination.
create or replace function public.record_delivery(
  p_entry       uuid,
  p_integration uuid,
  p_status      text,
  p_error       text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.form_entries where id = p_entry;
  if v_org is null then
    raise exception 'no such sign-in';
  end if;

  insert into public.entry_deliveries (entry_id, integration_id, org_id, status, error, attempted_at)
  values (p_entry, p_integration, v_org, p_status, left(p_error, 500), now())
  on conflict (entry_id, integration_id) do update
    set status = excluded.status,
        error = excluded.error,
        attempted_at = excluded.attempted_at;
end;
$$;

revoke all on function public.record_delivery(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.record_delivery(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice. Neither function may be callable from a
-- browser role: one returns a decrypted credential, the other writes history.
select p.proname,
       coalesce(pg_catalog.array_to_string(p.proacl, ' | '), '(owner only)') as grants
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('integration_targets', 'record_delivery')
order by p.proname;
