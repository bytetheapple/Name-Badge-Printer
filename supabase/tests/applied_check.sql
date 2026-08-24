-- What is actually applied to this database?
--
-- Read-only. Paste into the SQL editor when you are unsure which migrations
-- have gone in — after several phases it is easy to lose track, and the answer
-- is not recorded anywhere else since these are applied by hand.
--
-- Every row should read 'yes'. Anything reading 'NO' names the migration to run.

with checks(phase, thing, present) as (values
  ('A1', 'organizations table',
   to_regclass('public.organizations') is not null),
  ('A1', 'memberships table',
   to_regclass('public.memberships') is not null),
  ('A1', 'form_entries.org_id',
   exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='form_entries' and column_name='org_id')),
  ('A2', 'auth_org_role() helper',
   to_regprocedure('public.auth_org_role(uuid)') is not null),
  ('A2', 'org_members() helper',
   to_regprocedure('public.org_members(uuid)') is not null),
  ('A3', 'bridge_tokens table',
   to_regclass('public.bridge_tokens') is not null),
  ('A4', 'printers.kiosk_token',
   exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='printers' and column_name='kiosk_token')),
  ('A4', 'api_keys table',
   to_regclass('public.api_keys') is not null),
  ('A4', 'submit_events table',
   to_regclass('public.submit_events') is not null),
  ('A4', 'transitional org_id trigger REMOVED',
   not exists (select 1 from pg_trigger where not tgisinternal and tgname like '%_set_org_id')),
  ('A5', 'integrations table',
   to_regclass('public.integrations') is not null),
  ('A5', 'integration_for() helper',
   to_regprocedure('public.integration_for(uuid,text)') is not null),
  ('A5b', 'oauth_pending table',
   to_regclass('public.oauth_pending') is not null),
  ('B2', 'discovered_printers table',
   to_regclass('public.discovered_printers') is not null),
  ('B2', 'printer_status.scan_requested_at',
   exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='printer_status'
             and column_name='scan_requested_at')),
  ('B2', 'printer_status.scan_completed_at',
   exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='printer_status'
             and column_name='scan_completed_at')),
  ('FIX', 'integration_for() not callable by authenticated',
   to_regprocedure('public.integration_for(uuid,text)') is null
   or not has_function_privilege('authenticated', 'public.integration_for(uuid,text)', 'execute')),
  ('FIX', 'check_submit_allowed() not callable by authenticated',
   to_regprocedure('public.check_submit_allowed(uuid,uuid,text,int,int,int,int,interval)') is null
   or not has_function_privilege('authenticated',
        'public.check_submit_allowed(uuid,uuid,text,int,int,int,int,interval)', 'execute'))
)
select phase,
       thing,
       case when present then 'yes' else 'NO  <-- run this migration' end as applied
from checks
order by array_position(array['A1','A2','A3','A4','A5','A5b','B2','FIX'], phase), thing;
