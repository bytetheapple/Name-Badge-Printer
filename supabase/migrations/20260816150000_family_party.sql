-- Family / party sign-ins: one primary person (with contact info + selfie) plus
-- additional name-only people who share a party_id and each get their own badge.
alter table public.form_entries add column if not exists party_id uuid;
alter table public.form_entries add column if not exists is_primary boolean not null default true;
create index if not exists form_entries_party_id_idx on public.form_entries (party_id);
