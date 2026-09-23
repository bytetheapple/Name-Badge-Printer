-- The slug column was dropped (20261005120000), but the organization activity
-- triggers were not updated with it, so they still read new.slug / old.slug.
-- Creating an organization fired the AFTER INSERT trigger and failed with
-- 'record "new" has no field "slug"'; deleting one would fail the same way.
-- Redefine both without the slug. (Dropping a column does not check function
-- bodies, which is why this slipped through until an insert ran the trigger.)
create or replace function public.log_organization_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_activity(new.id, 'org.create', new.name, '{}'::jsonb);
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      perform public.log_activity(new.id, 'org.status', new.name,
        jsonb_build_object('from', old.status, 'to', new.status));
    end if;
    if new.custom_integrations is distinct from old.custom_integrations then
      perform public.log_activity(new.id, 'org.custom_integrations', new.name,
        jsonb_build_object('enabled', new.custom_integrations));
    end if;
    if new.name is distinct from old.name then
      perform public.log_activity(new.id, 'org.rename', new.name,
        jsonb_build_object('from', old.name));
    end if;
  end if;
  return null;
end;
$$;

create or replace function public.log_organization_deleted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.log_activity(null, 'org.delete', old.name,
    jsonb_build_object(
      'members', (select count(*) from public.memberships where org_id = old.id),
      'entries', (select count(*) from public.form_entries where org_id = old.id)));
  return old;
end;
$$;
