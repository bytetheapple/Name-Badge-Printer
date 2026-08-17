-- Custom, programmable header graphics for badges.
--
-- A header image can be set per printer (in the admin) and/or per job (via the
-- external print API). Precedence at render time: per-job > per-printer > the
-- bundled default logo. Both store a public URL into a Supabase Storage bucket;
-- the print bridge fetches and caches it.

alter table public.printers add column if not exists header_image_url text;
alter table public.print_jobs add column if not exists header_image_url text;

-- Public bucket holding uploaded header graphics (small PNG/JPEG logos).
insert into storage.buckets (id, name, public)
values ('badge-headers', 'badge-headers', true)
on conflict (id) do nothing;

-- Admins (authenticated) manage header files; anyone may read (public bucket).
-- The print API uploads with the service role, which bypasses these policies.
drop policy if exists "badge-headers admin insert" on storage.objects;
drop policy if exists "badge-headers admin update" on storage.objects;
drop policy if exists "badge-headers admin delete" on storage.objects;
drop policy if exists "badge-headers public read" on storage.objects;

create policy "badge-headers admin insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'badge-headers');
create policy "badge-headers admin update" on storage.objects
  for update to authenticated using (bucket_id = 'badge-headers');
create policy "badge-headers admin delete" on storage.objects
  for delete to authenticated using (bucket_id = 'badge-headers');
create policy "badge-headers public read" on storage.objects
  for select using (bucket_id = 'badge-headers');
