-- ============================================================================
-- Connect a Google account, instead of asking for a service-account key
--
-- Today an organization wanting selfies in Drive or sign-ins in a Sheet has to
-- create a Google Cloud service account, download a JSON key, and paste a PEM
-- into a form. That is a reasonable ask of a developer and an unreasonable one
-- of a synagogue office, and it is the last piece of setup that needs someone
-- technical in the room.
--
-- After this an owner clicks Connect Google, approves once, and the files land
-- in *their* Drive on *their* quota — which also removes the shared-drive
-- workaround a service account needs, having no storage of its own.
--
-- Scope is `drive.file`: access to files this application itself created, and
-- nothing else. It is non-sensitive, so it avoids Google's restricted-scope
-- security assessment — which is why the Sheets integration will create the
-- sheet rather than accept a link to an existing one. A pasted link is not a
-- file we created, and covering it would need a scope that triggers the
-- assessment.
--
-- Additive.
-- ============================================================================

-- ------------------------------------------------------------- 1. the kind
alter table public.integrations drop constraint if exists integrations_kind_check;
alter table public.integrations
  add constraint integrations_kind_check
  check (kind in ('google_form', 'shulcloud', 'google_drive', 'google_sheet', 'google_oauth'));

-- --------------------------------------------- 2. the in-flight authorization
-- One row per connect attempt, living about as long as it takes somebody to
-- read a Google consent screen.
--
-- It exists to carry two things across the redirect: the PKCE verifier, and —
-- more importantly — *which organization asked*. The callback is a public URL
-- that anyone may hit with any query string, so the org can never come from
-- the request. It comes from a row only an authenticated owner could create.
-- Same rule as the kiosk and bridge tokens.
create table if not exists public.oauth_pending (
  state          text primary key,
  org_id         uuid not null references public.organizations (id) on delete cascade,
  --: The integration instance being connected. Integrations are many-per-kind
  --: now, so "the org's Google connection" is not a thing a callback can look
  --: up — it has to be told which row it is finishing.
  integration_id uuid not null references public.integrations (id) on delete cascade,
  code_verifier  text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '10 minutes'
);

alter table public.oauth_pending enable row level security;
-- No policies, and no grants: nothing but service_role, which bypasses RLS,
-- has any business reading a verifier. Both are needed — a table with RLS on
-- and no policies still answers the Data API if the grant is there.
revoke all on public.oauth_pending from anon, authenticated;

create index if not exists oauth_pending_expiry_idx on public.oauth_pending (expires_at);

-- ------------------------------------------------------- 3. finishing the job
-- Called by the callback, which has no auth.uid() and therefore cannot use the
-- owner-checked set_integration_secret. Everything it trusts comes out of the
-- pending row: the state is the capability.
create or replace function public.complete_google_oauth(
  p_state         text,
  p_refresh_token text,
  p_email         text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, vault
as $$
declare
  v_pending public.oauth_pending%rowtype;
  v_row     public.integrations%rowtype;
  v_name    text;
  v_new     uuid;
begin
  select * into v_pending
    from public.oauth_pending
   where state = p_state and expires_at > now();
  if not found then
    -- Expired or never existed. Deliberately the same answer for both: a
    -- caller guessing at states learns nothing from the difference.
    raise exception 'that connection request is no longer valid';
  end if;

  select * into v_row from public.integrations where id = v_pending.integration_id;
  if not found then
    raise exception 'the integration was removed while connecting';
  end if;

  if p_refresh_token is null or length(btrim(p_refresh_token)) = 0 then
    raise exception 'Google did not return a refresh token';
  end if;

  v_name := format('org:%s:%s:%s', v_row.org_id, v_row.kind, v_row.id);
  if v_row.secret_id is null then
    v_new := vault.create_secret(p_refresh_token, v_name, 'Google OAuth refresh token');
    update public.integrations set secret_id = v_new where id = v_row.id;
  else
    perform vault.update_secret(v_row.secret_id, p_refresh_token);
  end if;

  update public.integrations
     set enabled    = true,
         config     = coalesce(config, '{}'::jsonb)
                      || jsonb_build_object('connected_email', p_email,
                                            'connected_at', now()),
         updated_at = now()
   where id = v_row.id;

  delete from public.oauth_pending where state = p_state;

  return jsonb_build_object('org_id', v_pending.org_id, 'integration_id', v_row.id);
end;
$$;

-- Server-only. Both revokes are load-bearing: a new function is executable by
-- PUBLIC by default, and this one writes a credential.
revoke all on function public.complete_google_oauth(text, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_google_oauth(text, text, text) to service_role;

-- Stragglers: an abandoned consent screen leaves a row behind. Cheap to clear
-- opportunistically rather than scheduling anything.
create or replace function public.purge_oauth_pending()
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.oauth_pending where expires_at < now();
$$;
revoke all on function public.purge_oauth_pending() from public, anon, authenticated;
grant execute on function public.purge_oauth_pending() to service_role;

select p.proname,
       coalesce(pg_catalog.array_to_string(p.proacl, ' | '), '(owner only)') as grants
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('complete_google_oauth', 'purge_oauth_pending')
order by p.proname;
