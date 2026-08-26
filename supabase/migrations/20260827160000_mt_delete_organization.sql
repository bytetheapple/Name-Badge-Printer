-- ============================================================================
-- Deleting a tenant
--
-- Wanted for testing — fictitious organizations should not accumulate — but
-- the same button sits beside real congregations, and this is the one action
-- in the product with no undo. Suspension is reversible; this is not.
--
-- The guard is the slug, typed by hand. It is the standard pattern because it
-- works: you cannot type "beth-shalom" while believing you are looking at
-- "shir-hadash". The console also shows what will be destroyed before asking.
--
-- Additive and idempotent.
-- ============================================================================

create or replace function public.delete_organization(p_org uuid, p_confirm_slug text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org  public.organizations%rowtype;
  v_gone jsonb;
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'only the Name Badge Kiosk team can delete an organization'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_org from public.organizations where id = p_org;
  if not found then
    raise exception 'no such organization';
  end if;

  -- Typed by hand, and compared to the row we actually found rather than to
  -- anything the caller supplied alongside it.
  if btrim(coalesce(p_confirm_slug, '')) <> v_org.slug then
    raise exception 'to delete %, type its slug exactly: %', v_org.name, v_org.slug;
  end if;

  -- Counted before the delete, and returned, so the answer to "what did I just
  -- destroy?" exists after the fact rather than only in the confirmation.
  select jsonb_build_object(
    'name',        v_org.name,
    'slug',        v_org.slug,
    'printers',    (select count(*) from public.printers where org_id = p_org),
    'entries',     (select count(*) from public.form_entries where org_id = p_org),
    'print_jobs',  (select count(*) from public.print_jobs where org_id = p_org),
    'members',     (select count(*) from public.memberships where org_id = p_org),
    'bridges',     (select count(*) from public.bridge_tokens where org_id = p_org),
    'api_keys',    (select count(*) from public.api_keys where org_id = p_org)
  ) into v_gone;

  -- Everything that carries org_id cascades, and the two Vault-cleanup
  -- triggers (integrations, provisioning_sessions) fire on the cascaded rows,
  -- so no decrypted credential is left behind. A2's last-owner guard already
  -- stands down when the organization itself is going away.
  --
  -- Two things deliberately survive: the users, because a person may belong to
  -- other organizations and deleting the account is a separate decision; and
  -- uploaded images in storage, which are content-addressed and may be shared
  -- with another org's identical upload.
  delete from public.organizations where id = p_org;

  return v_gone;
end;
$$;

comment on function public.delete_organization(uuid, text) is
  'Delete a tenant and everything it owns. Platform admins only, and the slug '
  'must be typed to match. Returns what was destroyed. There is no undo.';

grant execute on function public.delete_organization(uuid, text) to authenticated, service_role;
