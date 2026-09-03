-- ============================================================================
-- A Google Sheet of visitor sign-ins
--
-- One sheet per organization, one row per visitor. Members are never sent —
-- the same rule the Google Form and ShulCloud syncs follow, and it is enforced
-- where they enforce it, at the point the sign-in is submitted.
--
-- Service-account mode. The congregation makes the sheet in their own Drive
-- and shares it with a service account; the sheet stays theirs. The other way
-- round — this application creating the sheet — would leave a congregation's
-- visitor log owned by a service account, in a Drive no person can open, and
-- orphaned the day that key is rotated. That version becomes worth building
-- with OAuth, where the sheet is created in the operator's own Drive and
-- belongs to them.
--
-- Additive.
-- ============================================================================

alter table public.integrations drop constraint if exists integrations_kind_check;
alter table public.integrations
  add constraint integrations_kind_check
  check (kind in ('google_form', 'shulcloud', 'google_drive', 'google_sheet'));

-- ------------------------------------------------- which row a sign-in wrote
-- Where this sign-in landed at this destination, when the destination has a
-- place. For a sheet it is the A1 range the append returned ("Sheet1!A7:G7").
--
-- It buys two things that are not optional:
--
--   The selfie. A photo is uploaded in the background, after the sign-in has
--   already been submitted and this row already written, so at append time the
--   link does not exist yet. Knowing the row means the cell can be filled in
--   when the photo lands, instead of the column being permanently empty on
--   every visitor who had their picture taken.
--
--   Resending. Without it, a retry from the Entries table appends the visitor
--   a second time. A duplicate row is worse than a failed one, because nobody
--   goes looking for it.
alter table public.entry_deliveries
  add column if not exists ref text;

comment on column public.entry_deliveries.ref is
  'Where this sign-in landed at this destination — for a Google Sheet, the A1 '
  'range of its row. Lets a later selfie fill in its cell, and makes a resend '
  'update the row it already wrote instead of appending a second one.';

-- Separate from record_delivery rather than another argument on it: adding a
-- defaulted parameter would leave two overloads and make every existing
-- four-argument call ambiguous, and dropping the old one mid-flight would fail
-- the syncs that are calling it right now.
create or replace function public.record_delivery_ref(
  p_entry       uuid,
  p_integration uuid,
  p_ref         text
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  update public.entry_deliveries
     set ref = left(p_ref, 200)
   where entry_id = p_entry
     and integration_id = p_integration;
end;
$$;

-- Server-only. Both revokes are load-bearing on this project: a new function
-- is executable by PUBLIC by default.
revoke all on function public.record_delivery_ref(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_delivery_ref(uuid, uuid, text) to service_role;

select p.proname,
       coalesce(pg_catalog.array_to_string(p.proacl, ' | '), '(owner only)') as grants
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'record_delivery_ref';
