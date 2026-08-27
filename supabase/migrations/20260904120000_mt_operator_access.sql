-- ============================================================================
-- Operators reach every organization
--
-- Until now an operator's access came from holding a membership, which is the
-- thing the operator/customer split exists to undo. The platform policies gave
-- them cross-tenant SELECT and nothing else, so setting a congregation up
-- before handover — printers, integrations, the first owner — was only
-- possible because the operator was quietly a member of it.
--
-- Two functions, not nineteen policies. Every write policy in this schema
-- routes through auth_org_ids() or auth_org_role(), so widening those two
-- means every existing policy inherits operator access, and so does every
-- policy written after today. Editing nineteen policies would have meant
-- getting all nineteen right and then remembering the rule forever.
--
-- Operators get OWNER-equivalent access inside a customer's organization —
-- not read-only, and not scaled by their platform role. Setting a tenant up
-- requires it, and a support operator diagnosing a broken sync needs the same
-- reach as the person who built it. What keeps that accountable is the
-- activity log, not a second role system layered on top of this one.
--
-- The platform role still governs platform actions: deleting an organization
-- and managing operators remain owner-only. Being able to act inside a tenant
-- is not the same as being able to destroy it.
--
-- Two things this deliberately does NOT do:
--   * It does not touch the platform_admins table, so an operator still holds
--     no membership anywhere and stays absent from every customer's Members
--     tab as a fact rather than as a filter.
--   * It does not scope access to one org at a time. Every list read in the
--     admin carries an explicit org_id filter, so widening these does not
--     spill one tenant's rows onto another's page — but it does mean an
--     operator's session has authority over every tenant at once, which is
--     what the banner and the marked background exist to make impossible to
--     forget.
--
-- Additive and idempotent.
-- ============================================================================

-- The orgs the caller may act in: the ones they belong to, plus all of them if
-- they are an operator. is_platform_admin() is STABLE, so the second branch
-- collapses to nothing for an ordinary member rather than being evaluated per
-- organization.
create or replace function public.auth_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id from public.memberships where user_id = auth.uid()
  union
  select id from public.organizations where public.is_platform_admin()
$$;

-- The caller's role in one organization. An operator is an owner everywhere,
-- which is what makes every `auth_is_org_admin` and `auth_is_org_owner` check
-- in the schema follow along without being touched.
create or replace function public.auth_org_role(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select m.role
       from public.memberships m
      where m.org_id = p_org and m.user_id = auth.uid()),
    case when public.is_platform_admin() then 'owner' end
  )
$$;

comment on function public.auth_org_role(uuid) is
  'The caller''s role in one organization. Operators are owners everywhere; a '
  'real membership still wins, so a person who is both keeps their own role.';

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice. For a signed-in operator both counts are the
-- number of organizations; run as anyone else they reflect that person's
-- memberships. Pasted in the SQL editor there is no auth.uid(), so this simply
-- confirms the functions compile and return without error.
select
  (select count(*) from public.organizations)        as organizations,
  (select count(*) from public.auth_org_ids())       as reachable_by_caller,
  public.auth_org_role((select id from public.organizations limit 1)) as caller_role_in_first;
