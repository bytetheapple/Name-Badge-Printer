-- ============================================================================
-- Multi-tenant Phase A1 — step 2 of 3: BACKFILL + CONSTRAIN
--
-- Shir Hadash becomes org #1, every existing row is stamped with it, the
-- current admin users get owner memberships, and org_id is then made NOT NULL.
-- Run AFTER _foundations and BEFORE _rls.
--
-- Idempotent: safe to re-run.
-- See MULTI_TENANT_DESIGN.md §14.
-- ============================================================================

-- ------------------------------------------------------- 1. the first tenant

insert into public.organizations (slug, name)
values ('shir-hadash', 'Shir Hadash')
on conflict (slug) do nothing;

-- --------------------------------- 2. stamp existing rows + owner memberships

do $$
declare
  org uuid;
begin
  select id into org from public.organizations where slug = 'shir-hadash';

  update public.form_entries   set org_id = org where org_id is null;
  update public.print_jobs     set org_id = org where org_id is null;
  update public.printers       set org_id = org where org_id is null;
  update public.printer_config set org_id = org where org_id is null;
  update public.printer_status set org_id = org where org_id is null;
  update public.app_settings   set org_id = org where org_id is null;

  -- The per-org singletons must exist before org_id goes NOT NULL. They were
  -- seeded as id = 1 at install, but re-create them if a deployment lost them.
  insert into public.printer_config (org_id) select org
    where not exists (select 1 from public.printer_config where org_id = org);
  insert into public.printer_status (org_id) select org
    where not exists (select 1 from public.printer_status where org_id = org);
  insert into public.app_settings (org_id) select org
    where not exists (select 1 from public.app_settings where org_id = org);

  -- Sign-ups are disabled on this project and admins are invite-only, so every
  -- existing auth user is a Shir Hadash administrator -> owner.
  insert into public.memberships (org_id, user_id, role)
  select org, u.id, 'owner' from auth.users u
  on conflict (org_id, user_id) do nothing;
end;
$$;

-- ------------------------------------------------------- 3. platform operator
-- Cross-tenant support access for the operator. REVIEW THIS LINE before
-- pasting: change the address, or drop the statement, if that is not wanted.

insert into public.platform_admins (user_id)
select id from auth.users where email = 'shelbert@me.com'
on conflict (user_id) do nothing;

-- ------------------------------------- 4. keep future inserts stamped (A4 tmp)
-- Existing writers (public sign-in + print API Edge Functions, and the admin
-- UI) do not send org_id yet, so a trigger fills it before NOT NULL can bite.
-- Removed in A4 once every writer derives org_id from its own token.

drop trigger if exists form_entries_set_org_id   on public.form_entries;
drop trigger if exists print_jobs_set_org_id     on public.print_jobs;
drop trigger if exists printers_set_org_id       on public.printers;
drop trigger if exists printer_config_set_org_id on public.printer_config;
drop trigger if exists printer_status_set_org_id on public.printer_status;
drop trigger if exists app_settings_set_org_id   on public.app_settings;

create trigger form_entries_set_org_id   before insert on public.form_entries   for each row execute function public.set_org_id_default();
create trigger print_jobs_set_org_id     before insert on public.print_jobs     for each row execute function public.set_org_id_default();
create trigger printers_set_org_id       before insert on public.printers       for each row execute function public.set_org_id_default();
create trigger printer_config_set_org_id before insert on public.printer_config for each row execute function public.set_org_id_default();
create trigger printer_status_set_org_id before insert on public.printer_status for each row execute function public.set_org_id_default();
create trigger app_settings_set_org_id   before insert on public.app_settings   for each row execute function public.set_org_id_default();

-- ------------------------------------------------------------ 5. constrain

alter table public.form_entries   alter column org_id set not null;
alter table public.print_jobs     alter column org_id set not null;
alter table public.printers       alter column org_id set not null;
alter table public.printer_config alter column org_id set not null;
alter table public.printer_status alter column org_id set not null;
alter table public.app_settings   alter column org_id set not null;

-- ------------------------------------------------------------ 6. verify
-- Fails loudly (rather than leaving a half-migrated database) if anything is
-- still unstamped or the first tenant has no owner.

do $$
declare
  org uuid;
  n   int;
begin
  select id into org from public.organizations where slug = 'shir-hadash';
  if org is null then
    raise exception 'backfill: the shir-hadash organization was not created';
  end if;

  select count(*) into n from public.memberships where org_id = org and role = 'owner';
  if n = 0 then
    raise exception 'backfill: org % has no owner membership (are there any auth users?)', org;
  end if;

  raise notice 'backfill ok: org %, % owner(s), % entries, % jobs, % printers',
    org, n,
    (select count(*) from public.form_entries where org_id = org),
    (select count(*) from public.print_jobs   where org_id = org),
    (select count(*) from public.printers     where org_id = org);
end;
$$;
