-- ============================================================================
-- Integration changes on the record
--
-- The log covered who has access and what hardware exists, but not where a
-- congregation's visitor data goes — which is the more consequential of the
-- three. Switching on a destination, or pointing an existing one at a
-- different URL, starts names, emails and phone numbers flowing somewhere new.
-- Renaming an organization was logged; that was not.
--
-- The rule is "what gets saved is an event", which the UI already makes clean:
-- the switches write on click and each is its own event, the text fields write
-- on Save and are one event between them.
--
-- Three things beyond that:
--
--   * Both sides of a configuration change are kept, not just the new one. "It
--     is this now" does not answer "what was it before, and is that why the
--     syncs stopped on Tuesday". The changed keys are listed alongside so the
--     display has something short to show.
--
--   * A credential is an event but never a value. Storing or replacing the
--     Drive key is exactly the sort of thing an audit trail is for, and
--     exactly the sort of thing it must not contain.
--
--   * Per-printer choices count as saves too, because they are: the Printers
--     tab writes them on change. Resetting every printer to the default
--     produces one row per printer, which at these fleet sizes is a handful
--     and says more than a single "reset" would.
--
-- Config holds form URLs and field ids, never secrets — the Drive key lives in
-- Vault and only its id is on the row. So a config in the log is visible to
-- exactly the people who could already read it: that org's owner, and
-- operators, who have owner-equivalent access anyway.
--
-- Additive and idempotent.
-- ============================================================================

create or replace function public.log_integration_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed jsonb;
begin
  if tg_op = 'DELETE' then
    -- BEFORE, so the row is still there to describe. Returning null from a
    -- BEFORE trigger would cancel the delete.
    --
    -- Skipped when the organization itself is going: deleting a tenant
    -- cascades to its integrations, and a row blaming that on an org that no
    -- longer exists fails the foreign key and takes the whole delete with it.
    -- The deletion is already recorded at platform level by
    -- delete_organization, counts and all.
    if exists (select 1 from public.organizations where id = old.org_id) then
      perform public.log_activity(old.org_id, 'integration.delete', old.name,
        jsonb_build_object('kind', old.kind));
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    perform public.log_activity(new.org_id, 'integration.create', new.name,
      jsonb_build_object('kind', new.kind));
    return null;
  end if;

  -- One event per thing that changed, rather than one "updated" covering
  -- several: they are separate decisions and are made at separate moments.
  if new.enabled is distinct from old.enabled then
    perform public.log_activity(new.org_id, 'integration.enabled', new.name,
      jsonb_build_object('to', new.enabled));
  end if;

  if new.default_enabled is distinct from old.default_enabled then
    perform public.log_activity(new.org_id, 'integration.default', new.name,
      jsonb_build_object('to', new.default_enabled));
  end if;

  if new.name is distinct from old.name then
    perform public.log_activity(new.org_id, 'integration.rename', new.name,
      jsonb_build_object('from', old.name));
  end if;

  if new.config is distinct from old.config then
    select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_changed
    from (
      select k from jsonb_object_keys(coalesce(new.config, '{}'::jsonb)) as k
      union
      select k from jsonb_object_keys(coalesce(old.config, '{}'::jsonb)) as k
    ) keys
    where new.config -> k is distinct from old.config -> k;

    perform public.log_activity(new.org_id, 'integration.update', new.name,
      jsonb_build_object('changed', v_changed, 'from', old.config, 'to', new.config));
  end if;

  -- Only that it happened. The value is in Vault and stays there.
  if new.secret_id is distinct from old.secret_id then
    perform public.log_activity(new.org_id, 'integration.credential', new.name,
      jsonb_build_object('action',
        case when new.secret_id is null then 'cleared' else 'stored' end));
  end if;

  return null;
end;
$$;

drop trigger if exists integrations_activity on public.integrations;
create trigger integrations_activity
  after insert or update on public.integrations
  for each row execute function public.log_integration_activity();

drop trigger if exists integrations_delete_activity on public.integrations;
create trigger integrations_delete_activity
  before delete on public.integrations
  for each row execute function public.log_integration_activity();

-- ------------------------------------------------- per-printer exceptions
create or replace function public.log_printer_destination_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_printer     text;
  v_integration text;
  v_org         uuid := coalesce(new.org_id, old.org_id);
begin
  select p.name into v_printer
  from public.printers p where p.id = coalesce(new.printer_id, old.printer_id);
  select i.name into v_integration
  from public.integrations i where i.id = coalesce(new.integration_id, old.integration_id);

  if tg_op = 'DELETE' then
    -- The row going is a printer returning to the integration's own default,
    -- which is what "reset to the default" is made of — unless the whole
    -- organization is going, in which case see the note in
    -- log_integration_activity.
    if exists (select 1 from public.organizations where id = v_org) then
      perform public.log_activity(v_org, 'printer.destination', v_integration,
        jsonb_build_object('printer', v_printer, 'to', 'default'));
    end if;
    return old;
  end if;

  perform public.log_activity(v_org, 'printer.destination', v_integration,
    jsonb_build_object('printer', v_printer, 'to', case when new.enabled then 'on' else 'off' end));
  return null;
end;
$$;

drop trigger if exists printer_integrations_activity on public.printer_integrations;
create trigger printer_integrations_activity
  after insert or update on public.printer_integrations
  for each row execute function public.log_printer_destination_activity();

drop trigger if exists printer_integrations_delete_activity on public.printer_integrations;
create trigger printer_integrations_delete_activity
  before delete on public.printer_integrations
  for each row execute function public.log_printer_destination_activity();

-- --------------------------------------------- replacing a credential
-- The trigger sees secret_id change, which catches storing the first one and
-- clearing it. It cannot see a *replacement*: that updates the Vault secret in
-- place and never touches the row. "Who swapped our Drive key, and when" is
-- among the more important questions this log exists to answer, so the
-- function records it itself.
--
-- Unchanged otherwise.
create or replace function public.set_integration_secret(
  p_integration uuid,
  p_secret      text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row  public.integrations%rowtype;
  v_name text;
  v_new  uuid;
begin
  select * into v_row from public.integrations where id = p_integration;
  if not found then
    raise exception 'no such integration';
  end if;
  if not coalesce(public.auth_is_org_owner(v_row.org_id), false) then
    raise exception 'integrations are managed by an owner of this organization'
      using errcode = 'insufficient_privilege';
  end if;
  if p_secret is null or length(btrim(p_secret)) = 0 then
    raise exception 'the secret is empty';
  end if;

  v_name := format('org:%s:%s:%s', v_row.org_id, v_row.kind, v_row.id);
  if v_row.secret_id is null then
    -- The trigger logs this one: secret_id goes from null to a value.
    v_new := vault.create_secret(p_secret, v_name, 'Guest Badges integration credential');
    update public.integrations set secret_id = v_new where id = v_row.id;
  else
    perform vault.update_secret(v_row.secret_id, p_secret);
    perform public.log_activity(v_row.org_id, 'integration.credential', v_row.name,
      jsonb_build_object('action', 'replaced'));
  end if;
end;
$$;

grant execute on function public.set_integration_secret(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice. Four more triggers, and log_activity still
-- callable by nobody through the Data API.
select
  (select count(*) from pg_trigger t
    where not t.tgisinternal and t.tgname like '%_activity')                  as activity_triggers,
  (select coalesce(pg_catalog.array_to_string(p.proacl, ' | '), '(owner only)')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'log_activity')                as log_activity_grants;
