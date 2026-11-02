-- ============================================================================
-- Restore operators' cross-tenant write access.
--
-- The operator/customer split (mt_operator_access, 2026-09-04) gave operators
-- write access to every tenant table the cheap way: auth_org_ids() returned
-- every organization for a platform admin, so all ~19 membership-based write
-- policies inherited it without each being widened.
--
-- The greeter migration (mt_greeter_role, 2026-10-12) redefined auth_org_ids()
-- to exclude greeters and, by accident, dropped the platform-admin UNION with
-- it. Operators kept SELECT (dedicated "platform admins read X" policies) but
-- silently lost INSERT/UPDATE/DELETE on customer orgs — the first symptom being
-- a test print failing with "new row violates row-level security policy for
-- table print_jobs".
--
-- Restore the UNION, keeping the greeter exclusion. This repairs every operator
-- write at once, so the per-table "platform admins insert print_jobs" policy
-- added as a stopgap (20261101120000) is redundant and removed here, keeping to
-- the design of widening the function rather than each policy.
--
-- Idempotent.
-- ============================================================================

create or replace function public.auth_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id
    from public.memberships
   where user_id = auth.uid()
     and role <> 'greeter'
  union
  select id from public.organizations where public.is_platform_admin()
$$;

-- The stopgap, now covered by the restored function.
drop policy if exists "platform admins insert print_jobs" on public.print_jobs;
