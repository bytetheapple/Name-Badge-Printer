-- Per-organization control over the sign-in form: which questions each person
-- answers, and whether each is required, optional, or hidden -- separately for
-- members and visitors.
--
-- Until now the shape of the form was hardcoded: first and last name always,
-- phone and email required for visitors and optional for members, pronouns
-- behind a single switch. A customer wanted to shape their own form, so the
-- shape moves into a setting the admin console edits. First and last name are
-- not represented here -- they are always shown and always required. Selfie
-- stays in selfie_mode (it is visitor-only and tied to the Google Drive
-- connection); this covers pronouns, phone and email, per audience.
alter table public.app_settings
  add column if not exists field_config jsonb;

comment on column public.app_settings.field_config is
  'Per-audience form field states: {member:{pronouns,phone,email}, visitor:{...}}, each hidden|optional|required. Null falls back to the built-in defaults (see _shared/formConfig.ts).';

-- Seed from the settings that drove the old hardcoded behaviour, so no
-- customer's form changes until they edit it: pronouns follows the old switch,
-- phone and email are optional for members and required for visitors.
update public.app_settings
set field_config = jsonb_build_object(
  'member', jsonb_build_object(
    'pronouns', case when coalesce(pronouns_enabled, false) then 'optional' else 'hidden' end,
    'phone', 'optional',
    'email', 'optional'
  ),
  'visitor', jsonb_build_object(
    'pronouns', case when coalesce(pronouns_enabled, false) then 'optional' else 'hidden' end,
    'phone', 'required',
    'email', 'required'
  )
)
where field_config is null;
