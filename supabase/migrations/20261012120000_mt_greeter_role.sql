-- ============================================================================
-- The greeter role: a per-tenant, portal-only role for a security/greeting desk.
--
-- A greeter verifies guests at the door — they see recent visitor sign-ins and
-- their photos — and nothing else. They cannot read the admin tables (entries,
-- printers, settings, integrations, other members) directly, and cannot write
-- anything (writes are already gated to owner/admin). Everything the portal
-- needs comes through the greeter Edge Functions, which check the role with the
-- service role.
--
-- How "nothing else" is enforced: auth_org_ids() backs every org-scoped read
-- policy, so excluding greeters there removes all of it in one place. Two narrow
-- additive policies then let a user read their OWN membership row and their OWN
-- org's name, which is all the app needs to know a greeter's organization and
-- route them to the portal.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships
  add constraint memberships_role_check
    check (role in ('owner', 'admin', 'staff', 'greeter'));

create or replace function public.auth_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id
    from public.memberships
   where user_id = auth.uid()
     and role <> 'greeter'
$$;

-- Your own membership row, regardless of role. Additive (OR) alongside the
-- existing "see all members of your orgs" policy — which, via auth_org_ids,
-- now excludes greeters; this is what still shows a greeter their own row.
drop policy if exists "read own membership row" on public.memberships;
create policy "read own membership row" on public.memberships
  for select to authenticated
  using (user_id = auth.uid());

-- The org a user belongs to, by membership rather than auth_org_ids, so a
-- greeter can read their own organization's name (nothing else about it).
drop policy if exists "read org of own membership" on public.organizations;
create policy "read org of own membership" on public.organizations
  for select to authenticated
  using (
    id in (select org_id from public.memberships where user_id = auth.uid())
  );
