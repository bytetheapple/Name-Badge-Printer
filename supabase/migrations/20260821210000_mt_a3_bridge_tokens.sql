-- ============================================================================
-- Multi-tenant Phase A3 — per-bridge credentials
--
-- Today every Raspberry Pi holds the project's service_role key, which bypasses
-- RLS entirely: one stolen SD card would expose every tenant. A3 replaces it
-- with an opaque per-bridge token that resolves to exactly one org (and
-- optionally a subset of its printers) — MULTI_TENANT_DESIGN.md §3.4 and §9.
--
-- Only the SHA-256 of the token is stored. The secret is generated in the
-- admin's browser, shown once, and never sent to the database, so a database
-- dump cannot yield a working bridge credential.
--
-- Additive and idempotent. Nothing here changes how the current bridge works;
-- the Pi keeps running on service_role until it is cut over deliberately.
-- ============================================================================

create table if not exists public.bridge_tokens (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  name         text,                          -- "Lobby Pi"
  token_hash   text not null unique,          -- sha256 hex of the secret
  token_prefix text,                          -- first few chars, to tell tokens apart in the UI
  printer_ids  uuid[],                        -- null = every printer in the org
  last_seen    timestamptz,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);

create index if not exists bridge_tokens_org_id_idx on public.bridge_tokens (org_id);
create index if not exists bridge_tokens_hash_idx   on public.bridge_tokens (token_hash);

alter table public.bridge_tokens enable row level security;

-- Admins and owners manage their own org's bridges; staff have no business
-- with device credentials at all.
drop policy if exists "org read bridge_tokens" on public.bridge_tokens;
create policy "org read bridge_tokens" on public.bridge_tokens
  for select to authenticated
  using (public.auth_is_org_admin(org_id));

drop policy if exists "org insert bridge_tokens" on public.bridge_tokens;
create policy "org insert bridge_tokens" on public.bridge_tokens
  for insert to authenticated
  with check (public.auth_is_org_admin(org_id));

drop policy if exists "org update bridge_tokens" on public.bridge_tokens;
create policy "org update bridge_tokens" on public.bridge_tokens
  for update to authenticated
  using (public.auth_is_org_admin(org_id))
  with check (public.auth_is_org_admin(org_id));

drop policy if exists "org delete bridge_tokens" on public.bridge_tokens;
create policy "org delete bridge_tokens" on public.bridge_tokens
  for delete to authenticated
  using (public.auth_is_org_admin(org_id));

drop policy if exists "platform admins read bridge_tokens" on public.bridge_tokens;
create policy "platform admins read bridge_tokens" on public.bridge_tokens
  for select to authenticated
  using (public.is_platform_admin());

-- Column-level grants: an admin may create a token and list their bridges, but
-- `token_hash` is never handed back out. The hash is not the secret and is not
-- reversible, so this is belt-and-braces rather than the main defence — the
-- main defence is that the secret itself was never stored.
--
-- The explicit revoke matters: this project grants the Data API roles full
-- access to newly created tables, so without it the column grants below would
-- be additive to an already-total permission.
revoke all on public.bridge_tokens from anon, authenticated;

grant select (id, org_id, name, token_prefix, printer_ids, last_seen, created_at, revoked_at)
  on public.bridge_tokens to authenticated;
grant insert (org_id, name, token_hash, token_prefix, printer_ids)
  on public.bridge_tokens to authenticated;
grant update (name, printer_ids, revoked_at)
  on public.bridge_tokens to authenticated;
grant delete on public.bridge_tokens to authenticated;

-- anon keeps nothing: the public sign-in path never touches bridges.
