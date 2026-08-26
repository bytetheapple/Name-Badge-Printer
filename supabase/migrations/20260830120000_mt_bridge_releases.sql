-- ============================================================================
-- A record of what has been released
--
-- The fleet release was a free-text commit sha. That works and tells you
-- nothing: six weeks later, "a1b2c3d" answers neither what it changed nor
-- whether it is the one that broke a device.
--
-- Releases become rows with a name and a line about them, and the version
-- pickers choose from those. Typing a sha nobody has described is no longer
-- possible, which is the point: if a version is worth putting on a fleet, it
-- is worth a sentence.
--
-- Additive and idempotent.
-- ============================================================================

create table if not exists public.bridge_releases (
  id          uuid primary key default gen_random_uuid(),
  --: A commit sha or tag in the bridge repository.
  ref         text not null unique,
  --: What to call it in a dropdown. A tag name, or a date, or a word.
  label       text not null,
  --: What changed, in a sentence. Read by whoever is deciding months later
  --: whether to roll back to it.
  notes       text,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete set null
);

create index if not exists bridge_releases_created_idx
  on public.bridge_releases (created_at desc);

alter table public.bridge_releases enable row level security;

drop policy if exists "platform admins read releases" on public.bridge_releases;
create policy "platform admins read releases" on public.bridge_releases
  for select to authenticated using (public.is_platform_admin());

drop policy if exists "platform admins add releases" on public.bridge_releases;
create policy "platform admins add releases" on public.bridge_releases
  for insert to authenticated with check (public.is_platform_admin());

drop policy if exists "platform admins remove releases" on public.bridge_releases;
create policy "platform admins remove releases" on public.bridge_releases
  for delete to authenticated using (public.is_platform_admin());

-- This project grants the Data API roles full access to new tables, so the
-- policies above are only half of it.
revoke all on public.bridge_releases from anon, authenticated;
grant select, insert, delete on public.bridge_releases to authenticated;

-- The same shape the updater accepts and pin_pi_device enforces, checked once
-- more here so a bad ref cannot enter the catalogue at all. The leading hyphen
-- is separate: "--upload-pack" is all legal characters and git reads it as an
-- option rather than a ref.
alter table public.bridge_releases
  drop constraint if exists bridge_releases_ref_check;
alter table public.bridge_releases
  add constraint bridge_releases_ref_check
    check (ref ~ '^[A-Za-z0-9._/-]+$' and ref !~ '^-');

comment on table public.bridge_releases is
  'Versions that have been released, with a name and a description. The fleet '
  'release and any device hold are chosen from these rather than typed.';
