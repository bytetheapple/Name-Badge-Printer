-- ============================================================================
-- Staff read the printers, not the configuration
--
-- The role migration widened three reads to every member so that a staff
-- member could answer "what is this set to" without being able to change it.
-- On reflection the Printers and Settings tabs stay an admin's, so two of
-- those three grants are broader than anything the product intends to offer —
-- and a permission that exists only because nothing happens to use it is the
-- kind that gets used later by something nobody reviewed.
--
-- `printers` stays readable by every member. That one is load-bearing: the
-- Print Server tab shows per-printer state — ready, unreachable, what media is
-- loaded — and that is exactly the question a greeter at a sign-in table has.
--
-- Operators are unaffected. auth_is_org_admin() consults auth_org_role(),
-- which answers 'owner' for an operator in any organization, so tightening
-- these back to admin does not shut an operator out of a tenant.
--
-- Additive and idempotent.
-- ============================================================================

drop policy if exists "org read printer_config" on public.printer_config;
create policy "org read printer_config" on public.printer_config
  for select to authenticated
  using (public.auth_is_org_admin(org_id));

drop policy if exists "org read app_settings" on public.app_settings;
create policy "org read app_settings" on public.app_settings
  for select to authenticated
  using (public.auth_is_org_admin(org_id));

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice. printers should read 'any member'; the other
-- two should read 'admin'.
select tablename, policyname,
       case
         when coalesce(qual, with_check) like '%auth_is_org_owner%' then 'owner'
         when coalesce(qual, with_check) like '%auth_is_org_admin%' then 'admin'
         when coalesce(qual, with_check) like '%auth_org_ids%'      then 'any member'
         else '(other)'
       end as requires
from pg_policies
where schemaname = 'public'
  and tablename in ('printers', 'printer_config', 'app_settings')
  and cmd = 'SELECT'
  and policyname not like 'platform admins%'
order by tablename;
