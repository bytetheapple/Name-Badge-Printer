-- App-wide settings (singleton) for the visitor selfie feature.
create table public.app_settings (
  id                     int primary key default 1 check (id = 1),
  selfie_mode            text not null default 'off'
                           check (selfie_mode in ('off', 'optional', 'required')),
  selfie_drive_folder_id text,
  updated_at             timestamptz not null default now()
);

insert into public.app_settings (id) values (1) on conflict (id) do nothing;

create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- Admins manage settings. anon has no access; the public form reads selfie_mode
-- through the public-config Edge Function (service_role), which exposes only the
-- mode, not the Drive folder id.
alter table public.app_settings enable row level security;
create policy "admins read app_settings"
  on public.app_settings for select to authenticated using (true);
create policy "admins update app_settings"
  on public.app_settings for update to authenticated using (true) with check (true);

-- Record where a visitor's selfie landed in Google Drive.
alter table public.form_entries add column selfie_link text;
