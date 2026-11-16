-- Welile Schools gate: a student has at most one entry and one exit per day (Africa/Kampala).
-- Enforced in the database so offline phones that sync later cannot add a second one.
-- Only registered students (role_type 'pupil' with a profile) are limited; staff and visitors are not.
--
-- The only duplicates when this was applied (2026-11-16) were a test student's scan-testing records;
-- they are removed first (earliest entry and exit kept), or the index cannot be created.

delete from public.welile_school_gate_logs
 where id in ('bcfba0e0-a7d6-4842-ad16-aea7dbfd5552','6fd3b511-7669-4d51-8e4d-ad45c4dfc13a',
              '95560dbf-aeb8-458e-bb79-e84f34718156','3cd2bc7f-25a1-4d3a-aee5-e9e36d5e4a0a')
   and profile_id = '00371e80-b3e5-485e-8e51-db703da501d6';

create unique index if not exists welile_school_gate_logs_one_per_day
  on public.welile_school_gate_logs (profile_id, direction, ((recorded_at at time zone 'Africa/Kampala')::date))
  where profile_id is not null and role_type = 'pupil';
