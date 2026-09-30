-- Clear a single provisioning secret, leaving the others in place.
--
-- clear_provisioning_secrets() forgets every secret a session holds, which is
-- right at the end of a run and wrong in the middle of one: the WiFi step still
-- needs the printer's web password. This drops just one kind.
--
-- The case that needs it: an open WiFi network. The operator can now say a
-- network has no password, but if an earlier attempt on the same session had
-- stored a passphrase, that value would linger in the vault and be handed to
-- the printer -- configuring WPA on a network that has none. set_provisioning_
-- secret cannot overwrite it with nothing (it rejects an empty secret), and
-- clear_provisioning_secrets would take the web password with it. So this
-- removes exactly one, and the WiFi cutover is the one step this system cannot
-- undo without a factory reset, so leaving a stale passphrase in place is not
-- an acceptable outcome.
create or replace function public.clear_provisioning_secret(
  p_session uuid,
  p_kind    text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.provisioning_sessions%rowtype;
  v_id  uuid;
begin
  if p_kind not in ('web_password', 'wifi_passphrase') then
    raise exception 'unknown provisioning secret %', p_kind;
  end if;

  select * into v_row from public.provisioning_sessions where id = p_session;
  if not found then
    return;
  end if;
  -- Admin of the org, or an Edge Function (service_role, which has no JWT and
  -- so is not subject to the admin check) -- mirrors clear_provisioning_secrets.
  if auth.uid() is not null
     and not coalesce(public.auth_is_org_admin(v_row.org_id), false) then
    raise exception 'not an administrator of this organization'
      using errcode = 'insufficient_privilege';
  end if;

  v_id := nullif(v_row.secrets ->> p_kind, '')::uuid;
  if v_id is not null then
    delete from vault.secrets where id = v_id;
  end if;
  update public.provisioning_sessions
     set secrets = secrets - p_kind
   where id = p_session;
end;
$$;

-- Same callers as set_provisioning_secret: an org admin from the browser, and
-- the Edge Functions. Not anon.
grant execute on function public.clear_provisioning_secret(uuid, text)
  to authenticated, service_role;
