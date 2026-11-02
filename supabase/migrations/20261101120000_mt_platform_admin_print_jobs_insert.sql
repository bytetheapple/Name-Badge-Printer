-- ============================================================================
-- Platform operators can queue print jobs on a customer org.
--
-- print_jobs has a platform-admin SELECT policy ("platform admins read
-- print_jobs") but no matching INSERT policy. Insert is governed only by "org
-- insert print_jobs", which requires membership via auth_org_ids(). Once the
-- operator/customer split made operator access stop being a membership, a
-- platform operator could see a customer's console but could not queue a test
-- print or a reprint — the insert failed with "new row violates row-level
-- security policy for table print_jobs".
--
-- Mirror the read grant for insert, keeping the same type guard the org policy
-- uses. This covers test prints and reprints, both of which are ordinary
-- support actions an operator performs on a customer's behalf.
--
-- Idempotent.
-- ============================================================================

drop policy if exists "platform admins insert print_jobs" on public.print_jobs;
create policy "platform admins insert print_jobs" on public.print_jobs
  for insert to authenticated
  with check (
    public.is_platform_admin()
    and type in ('badge', 'test')
  );
