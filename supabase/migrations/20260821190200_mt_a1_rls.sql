-- ============================================================================
-- Multi-tenant Phase A1 — step 3 of 3: RLS REWRITE
--
-- Replaces the single-tenant policies ("any authenticated user sees
-- everything") with org-scoped ones: a row is visible/writable only if its
-- org_id is one of the caller's memberships. Platform admins get an additional
-- cross-org READ policy.
--
-- Run AFTER _backfill — before the backfill, every org_id is NULL and these
-- policies would (correctly) hide every row from the admin portal.
--
-- Scope note: this migration changes WHO sees a row, not WHAT an admin may do.
-- Each table keeps exactly the capabilities it had (e.g. form_entries stays
-- read-only for the portal). Per-role capabilities land in A2.
--
-- The service_role paths (Edge Functions, print bridge) bypass RLS entirely and
-- are secured separately in A3/A4 — see MULTI_TENANT_DESIGN.md §4.3.
-- ============================================================================

-- --------------------------------------------------------- 1. tenant tables

alter table public.organizations   enable row level security;
alter table public.memberships     enable row level security;
alter table public.platform_admins enable row level security;

drop policy if exists "read own organizations" on public.organizations;
create policy "read own organizations" on public.organizations
  for select to authenticated
  using (id in (select public.auth_org_ids()));

drop policy if exists "platform admins read organizations" on public.organizations;
create policy "platform admins read organizations" on public.organizations
  for select to authenticated
  using (public.is_platform_admin());

drop policy if exists "read own org memberships" on public.memberships;
create policy "read own org memberships" on public.memberships
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

drop policy if exists "platform admins read memberships" on public.memberships;
create policy "platform admins read memberships" on public.memberships
  for select to authenticated
  using (public.is_platform_admin());

-- Only ever your own row: this table must not leak the operator list.
drop policy if exists "read own platform admin row" on public.platform_admins;
create policy "read own platform admin row" on public.platform_admins
  for select to authenticated
  using (user_id = auth.uid());

-- No insert/update/delete policies on any of the three: membership and org
-- management arrive in A2, provisioning in A6. Until then those writes happen
-- with the service_role key only.

-- ------------------------------------------------------------ 2. form_entries

drop policy if exists "admins read form_entries" on public.form_entries;

drop policy if exists "org read form_entries" on public.form_entries;
create policy "org read form_entries" on public.form_entries
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

drop policy if exists "platform admins read form_entries" on public.form_entries;
create policy "platform admins read form_entries" on public.form_entries
  for select to authenticated
  using (public.is_platform_admin());

-- -------------------------------------------------------------- 3. print_jobs

drop policy if exists "admins read print_jobs" on public.print_jobs;
drop policy if exists "admins insert print_jobs" on public.print_jobs;

drop policy if exists "org read print_jobs" on public.print_jobs;
create policy "org read print_jobs" on public.print_jobs
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

drop policy if exists "org insert print_jobs" on public.print_jobs;
create policy "org insert print_jobs" on public.print_jobs
  for insert to authenticated
  with check (
    org_id in (select public.auth_org_ids())
    and type in ('badge', 'test')
  );

drop policy if exists "platform admins read print_jobs" on public.print_jobs;
create policy "platform admins read print_jobs" on public.print_jobs
  for select to authenticated
  using (public.is_platform_admin());

-- ---------------------------------------------------------------- 4. printers

drop policy if exists "admins read printers" on public.printers;
drop policy if exists "admins insert printers" on public.printers;
drop policy if exists "admins update printers" on public.printers;
drop policy if exists "admins delete printers" on public.printers;

drop policy if exists "org read printers" on public.printers;
create policy "org read printers" on public.printers
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

drop policy if exists "org insert printers" on public.printers;
create policy "org insert printers" on public.printers
  for insert to authenticated
  with check (org_id in (select public.auth_org_ids()));

drop policy if exists "org update printers" on public.printers;
create policy "org update printers" on public.printers
  for update to authenticated
  using (org_id in (select public.auth_org_ids()))
  with check (org_id in (select public.auth_org_ids()));

drop policy if exists "org delete printers" on public.printers;
create policy "org delete printers" on public.printers
  for delete to authenticated
  using (org_id in (select public.auth_org_ids()));

drop policy if exists "platform admins read printers" on public.printers;
create policy "platform admins read printers" on public.printers
  for select to authenticated
  using (public.is_platform_admin());

-- ---------------------------------------------------------- 5. printer_config

drop policy if exists "admins read printer_config" on public.printer_config;
drop policy if exists "admins update printer_config" on public.printer_config;

drop policy if exists "org read printer_config" on public.printer_config;
create policy "org read printer_config" on public.printer_config
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

drop policy if exists "org update printer_config" on public.printer_config;
create policy "org update printer_config" on public.printer_config
  for update to authenticated
  using (org_id in (select public.auth_org_ids()))
  with check (org_id in (select public.auth_org_ids()));

drop policy if exists "platform admins read printer_config" on public.printer_config;
create policy "platform admins read printer_config" on public.printer_config
  for select to authenticated
  using (public.is_platform_admin());

-- ---------------------------------------------------------- 6. printer_status

drop policy if exists "admins read printer_status" on public.printer_status;

drop policy if exists "org read printer_status" on public.printer_status;
create policy "org read printer_status" on public.printer_status
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

drop policy if exists "platform admins read printer_status" on public.printer_status;
create policy "platform admins read printer_status" on public.printer_status
  for select to authenticated
  using (public.is_platform_admin());

-- ------------------------------------------------------------ 7. app_settings

drop policy if exists "admins read app_settings" on public.app_settings;
drop policy if exists "admins update app_settings" on public.app_settings;

drop policy if exists "org read app_settings" on public.app_settings;
create policy "org read app_settings" on public.app_settings
  for select to authenticated
  using (org_id in (select public.auth_org_ids()));

drop policy if exists "org update app_settings" on public.app_settings;
create policy "org update app_settings" on public.app_settings
  for update to authenticated
  using (org_id in (select public.auth_org_ids()))
  with check (org_id in (select public.auth_org_ids()));

drop policy if exists "platform admins read app_settings" on public.app_settings;
create policy "platform admins read app_settings" on public.app_settings
  for select to authenticated
  using (public.is_platform_admin());
