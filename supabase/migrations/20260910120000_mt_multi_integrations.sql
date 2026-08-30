-- ============================================================================
-- Integrations, plural
--
-- One row per kind per organization was the wrong shape. A congregation may
-- have two ShulCloud forms for two audiences, or a second Google Form for one
-- event, and the unique constraint said no. It also meant "integration" and
-- "kind of integration" were the same thing, so neither could be named.
--
-- Three changes, and the third is the one that makes the rest possible:
--
--   * `unique (org_id, kind)` goes, and every instance gets a name. The name
--     is looked up when a row is rendered rather than copied into it, so
--     renaming an integration updates every entry that was ever sent to it.
--
--   * Each integration says whether it is on by default for printers. Which
--     printers actually use it is per printer — the lobby desk and the
--     religious-school door may not feed the same places.
--
--   * printer_integrations holds ONLY the exceptions. Effective = the
--     override if there is one, otherwise the integration's default. Nothing
--     is seeded when a printer or an integration is created, nothing drifts
--     out of step, and "reset every printer to the default" is a DELETE.
--
-- entry_deliveries replaces the per-kind status columns as the source of
-- truth. One column per kind cannot say "sent to one ShulCloud form and
-- failed at the other", and partial delivery is the case someone has to act
-- on. The old columns stay for now and are still written; they come out once
-- the new path has run in production.
--
-- Additive. The backfill is idempotent and safe to paste twice.
-- ============================================================================

-- --------------------------------------------------------- 1. many per kind
alter table public.integrations drop constraint if exists integrations_org_id_kind_key;

alter table public.integrations
  add column if not exists name text not null default '';

--: Whether a printer that says nothing uses this. The per-printer table holds
--: exceptions only, so this is the answer for every printer without one.
alter table public.integrations
  add column if not exists default_enabled boolean not null default true;

-- Anything already configured keeps working and gets a readable name.
update public.integrations
   set name = case kind
                when 'google_form'  then 'Google Form'
                when 'shulcloud'    then 'ShulCloud'
                when 'google_drive' then 'Google Drive'
                else kind
              end
 where btrim(name) = '';

-- The grants on this table are column-level, deliberately: secret_id is left
-- out so a credential cannot be read or written through the Data API at all.
-- New columns are therefore invisible until named here, and a missing name in
-- this list shows up as a permission error rather than as anything readable.
grant select (id, org_id, kind, name, enabled, default_enabled, config, updated_at, created_at)
  on public.integrations to authenticated;
grant insert (org_id, kind, name, enabled, default_enabled, config)
  on public.integrations to authenticated;
grant update (name, enabled, default_enabled, config)
  on public.integrations to authenticated;

-- A name per organization, not globally: two congregations may each have a
-- "Main office" and neither should know about the other.
create unique index if not exists integrations_org_name_key
  on public.integrations (org_id, lower(btrim(name)));

-- ------------------------------------------------ 2. per-printer exceptions
create table if not exists public.printer_integrations (
  printer_id     uuid not null references public.printers (id)     on delete cascade,
  integration_id uuid not null references public.integrations (id) on delete cascade,
  org_id         uuid not null references public.organizations (id) on delete cascade,
  enabled        boolean not null,
  created_at     timestamptz not null default now(),
  primary key (printer_id, integration_id)
);

create index if not exists printer_integrations_org_idx
  on public.printer_integrations (org_id);

comment on table public.printer_integrations is
  'Exceptions only. A printer with no row for an integration follows that '
  'integration''s default_enabled, so resetting to the default is a DELETE '
  'rather than a rewrite of every row.';

alter table public.printer_integrations enable row level security;

drop policy if exists "org read printer_integrations" on public.printer_integrations;
create policy "org read printer_integrations" on public.printer_integrations
  for select to authenticated
  using (public.auth_is_org_admin(org_id));

drop policy if exists "org write printer_integrations" on public.printer_integrations;
create policy "org write printer_integrations" on public.printer_integrations
  for all to authenticated
  using (public.auth_is_org_admin(org_id))
  with check (public.auth_is_org_admin(org_id));

drop policy if exists "platform admins read printer_integrations" on public.printer_integrations;
create policy "platform admins read printer_integrations" on public.printer_integrations
  for select to authenticated
  using (public.is_platform_admin());

grant select, insert, update, delete on public.printer_integrations to authenticated;

-- ------------------------------------------------------ 3. what was sent where
create table if not exists public.entry_deliveries (
  id             bigint generated by default as identity primary key,
  entry_id       uuid not null references public.form_entries (id)  on delete cascade,
  --: Kept when the integration is deleted, so history does not lose the fact
  --: that something was sent somewhere. The name goes; the record stays.
  integration_id uuid references public.integrations (id) on delete set null,
  org_id         uuid not null references public.organizations (id) on delete cascade,
  status         text not null default 'pending'
                   check (status in ('pending', 'sent', 'failed', 'skipped')),
  error          text,
  attempted_at   timestamptz,
  created_at     timestamptz not null default now()
);

create unique index if not exists entry_deliveries_entry_integration_key
  on public.entry_deliveries (entry_id, integration_id);
create index if not exists entry_deliveries_org_idx on public.entry_deliveries (org_id, created_at desc);

alter table public.entry_deliveries enable row level security;

-- Readable by anyone in the org, like the entries themselves: a greeter who
-- can see a sign-in can see whether it reached the office's systems.
drop policy if exists "org read entry_deliveries" on public.entry_deliveries;
create policy "org read entry_deliveries" on public.entry_deliveries
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

drop policy if exists "platform admins read entry_deliveries" on public.entry_deliveries;
create policy "platform admins read entry_deliveries" on public.entry_deliveries
  for select to authenticated
  using (public.is_platform_admin());

-- Written by the sync functions with the service_role. Nobody edits a delivery
-- record by hand, for the same reason nobody edits the activity log.
grant select on public.entry_deliveries to authenticated;
grant select, insert, update on public.entry_deliveries to service_role;

-- Supabase's default privileges hand out more than that on every new table.
revoke truncate, references, trigger on public.entry_deliveries      from anon, authenticated;
revoke truncate, references, trigger on public.printer_integrations   from anon, authenticated;
revoke insert, update, delete on public.entry_deliveries              from anon, authenticated;

-- ------------------------------------------------------------- 4. backfill
-- History, from the per-kind columns onto the instances that now stand for
-- them. Only where the org actually has that integration, and only once.
insert into public.entry_deliveries (entry_id, integration_id, org_id, status, error, attempted_at)
select e.id, i.id, e.org_id,
       case s.status when 'sent' then 'sent'
                     when 'failed' then 'failed'
                     when 'skipped' then 'skipped'
                     else 'pending' end,
       s.err,
       case when s.status in ('sent', 'failed') then e.created_at end
from public.form_entries e
join lateral (values
  ('google_form',  e.google_sync_status,    e.google_error),
  ('shulcloud',    e.shulcloud_sync_status, e.shulcloud_error),
  ('google_drive', e.selfie_status,         e.selfie_error)
) as s(kind, status, err) on true
join public.integrations i on i.org_id = e.org_id and i.kind = s.kind
on conflict (entry_id, integration_id) do nothing;

-- ------------------------------------------------- 5. what a printer will use
-- The one question the sync path asks. Kept in the database rather than
-- rebuilt in three Edge Functions that would each drift from the others.
create or replace function public.integrations_for_printer(p_printer uuid)
returns table (id uuid, kind text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select i.id, i.kind, i.name
  from public.printers p
  join public.integrations i on i.org_id = p.org_id
  left join public.printer_integrations pi
         on pi.printer_id = p.id and pi.integration_id = i.id
  where p.id = p_printer
    and i.enabled                                     -- switched on at all
    and coalesce(pi.enabled, i.default_enabled)       -- and for this printer
  order by i.kind, i.name;
$$;

comment on function public.integrations_for_printer(uuid) is
  'Every integration a given printer should deliver to: enabled on the '
  'integration, and not switched off for this printer. Exceptions live in '
  'printer_integrations; everything else follows default_enabled.';

revoke all on function public.integrations_for_printer(uuid) from public, anon, authenticated;
grant execute on function public.integrations_for_printer(uuid) to service_role;

-- ------------------------------------------- 6. secrets belong to instances
-- set_integration_secret used `on conflict (org_id, kind)`, which stopped
-- existing the moment a kind could appear twice. A credential belongs to one
-- integration, so the real fix is to address it by id.
--
-- The by-kind form is kept and rewritten rather than dropped: the deployed
-- admin still calls it, migrations are applied by hand, and the two do not
-- land in the same instant. It resolves to the org's single instance of that
-- kind, which is every organization today, and refuses rather than guesses
-- once there is more than one.

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
    v_new := vault.create_secret(p_secret, v_name, 'Guest Badges integration credential');
    update public.integrations set secret_id = v_new where id = v_row.id;
  else
    perform vault.update_secret(v_row.secret_id, p_secret);
  end if;
end;
$$;

grant execute on function public.set_integration_secret(uuid, text) to authenticated, service_role;

create or replace function public.clear_integration_secret(p_integration uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.integrations%rowtype;
begin
  select * into v_row from public.integrations where id = p_integration;
  if not found then
    raise exception 'no such integration';
  end if;
  if not coalesce(public.auth_is_org_owner(v_row.org_id), false) then
    raise exception 'integrations are managed by an owner of this organization'
      using errcode = 'insufficient_privilege';
  end if;

  if v_row.secret_id is not null then
    delete from vault.secrets where id = v_row.secret_id;
    update public.integrations set secret_id = null where id = v_row.id;
  end if;
end;
$$;

grant execute on function public.clear_integration_secret(uuid) to authenticated, service_role;

create or replace function public.integration_has_secret(p_integration uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select i.secret_id is not null
    from public.integrations i
    where i.id = p_integration and public.auth_is_org_owner(i.org_id)
  ), false)
$$;

grant execute on function public.integration_has_secret(uuid) to authenticated, service_role;

-- The by-kind form, without the constraint it used to lean on.
create or replace function public.set_integration_secret(
  p_org    uuid,
  p_kind   text,
  p_secret text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_n  int;
begin
  if not coalesce(public.auth_is_org_owner(p_org), false) then
    raise exception 'integrations are managed by an owner of this organization'
      using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_n from public.integrations where org_id = p_org and kind = p_kind;
  if v_n > 1 then
    raise exception
      'this organization has % % integrations; set the credential on the one you mean', v_n, p_kind;
  end if;

  select id into v_id from public.integrations where org_id = p_org and kind = p_kind;
  if v_id is null then
    insert into public.integrations (org_id, kind, name)
    values (p_org, p_kind,
            case p_kind when 'google_form'  then 'Google Form'
                        when 'shulcloud'    then 'ShulCloud'
                        when 'google_drive' then 'Google Drive'
                        else p_kind end)
    returning id into v_id;
  end if;

  perform public.set_integration_secret(v_id, p_secret);
end;
$$;

grant execute on function public.set_integration_secret(uuid, text, text) to authenticated, service_role;

-- ------------------------------------------- 7. readiness, across instances
-- Now "is there at least one of these that would work", which is the question
-- the selfie setting actually asks: it needs somewhere to send a photo, not a
-- particular somewhere.
create or replace function public.integration_ready(p_org uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.integrations i
    where i.org_id = p_org
      and i.kind = p_kind
      and i.enabled
      and case p_kind
            when 'google_drive' then
              i.secret_id is not null
              and coalesce(i.config ->> 'sa_client_email', '') <> ''
            else true
          end
      and public.auth_is_org_admin(p_org)
  )
$$;

grant execute on function public.integration_ready(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice.
select
  (select count(*) from public.integrations)                                  as integrations,
  (select count(*) from public.integrations where btrim(name) = '')           as unnamed,
  (select count(*) from public.entry_deliveries)                              as deliveries_backfilled,
  (select count(*) from public.printer_integrations)                          as printer_overrides;
