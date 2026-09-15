-- Let an organization cancel its own badges that are still waiting to print.
--
-- When the print server is offline, scanned badges queue up and then print all
-- at once when it returns — wasting a roll of labels on people who signed in and
-- left the day before. There was no way to clear them: print_jobs had read and
-- insert policies for an org, but no delete. This adds one, narrowed to jobs
-- that have not been claimed yet (status 'queued'). A job the bridge has taken
-- to print ('printing') or already printed cannot be deleted from here, which
-- also means a cancel can never race a print that is already under way.
drop policy if exists "org cancel queued print_jobs" on public.print_jobs;
create policy "org cancel queued print_jobs" on public.print_jobs
  for delete to authenticated
  using (
    org_id in (select public.auth_org_ids())
    and status = 'queued'
  );
