-- The Print Server tab subscribes to this table, and a subscription to a table
-- that is not published takes the whole channel down with it -- including the
-- heartbeat the same page uses to decide whether the server is online. The
-- symptom was the Networks section vanishing 35 seconds after the page opened
-- and coming back on a tab switch, which looks nothing like a realtime fault.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'server_network_requests'
  ) then
    alter publication supabase_realtime add table public.server_network_requests;
  end if;
end
$$;
