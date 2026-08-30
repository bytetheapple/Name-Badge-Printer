-- ============================================================================
-- Two more things the sign-in form asks
--
--   * A visitor can tick "I want to learn more about <the congregation>".
--     Contact details are already collected from visitors; this is the
--     difference between having someone's email and having permission to use
--     it, and it is the whole reason a welcome desk collects anything.
--
--   * Each additional badge in a family sign-in can say how that person is
--     related to whoever is signing in. Family members are already separate
--     form_entries rows sharing a party_id, so this belongs on the rows where
--     is_primary is false — the primary is not related to themselves.
--
-- `relationship` is unconstrained text rather than an enum. The option list
-- ("Partner", "Child", "Parent", "Other") lives in the sign-in form, and a
-- check constraint here would mean a migration every time a congregation wants
-- a different word on a dropdown. Length is capped where it is written.
--
-- Additive and idempotent.
-- ============================================================================

alter table public.form_entries
  add column if not exists wants_followup boolean not null default false;

alter table public.form_entries
  add column if not exists relationship text;

comment on column public.form_entries.wants_followup is
  'The visitor asked to hear more from this congregation. False for members, '
  'and false for a visitor who did not tick the box — an untouched box is a '
  'no, not an unknown.';

comment on column public.form_entries.relationship is
  'How this person relates to whoever signed the family in. Null on the '
  'primary row, and null for a lone sign-in.';

-- Visitors who asked to be contacted are the list the office actually works
-- from, and it is a small slice of a large table.
create index if not exists form_entries_followup_idx
  on public.form_entries (org_id, created_at desc)
  where wants_followup;

-- ---------------------------------------------------------------- verify
-- A select, not a raise notice: the SQL editor discards notices.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'form_entries'
  and column_name in ('wants_followup', 'relationship')
order by column_name;
