-- ============================================================================
-- The hand-kept release catalogue comes out
--
-- It was built a day ago, from a misreading: "keep a record of the releases
-- from the repo" meant read them from git, not maintain a parallel list by
-- hand. The repository already holds a sha and a description for every commit,
-- and tags on top of that, so the console reads from there instead.
--
-- Dropped only if nothing was recorded in it. If anything was, it stays and
-- says so — deleting somebody's notes because the design moved on would be
-- the wrong trade, and the table costs nothing sitting there.
-- ============================================================================

do $$
declare
  n bigint := 0;
begin
  if to_regclass('public.bridge_releases') is null then
    return;
  end if;
  execute 'select count(*) from public.bridge_releases' into n;
  if n = 0 then
    drop table public.bridge_releases;
  end if;
end;
$$;

-- What happened, since the SQL editor shows the last row-returning statement
-- and discards notices.
select case
         when to_regclass('public.bridge_releases') is null
           then 'bridge_releases was empty and has been dropped'
         else 'bridge_releases still holds rows and was left alone — drop it by hand once you have read them'
       end as result;
