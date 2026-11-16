-- Welile Schools gate: a student has at most one entry and one exit per day (Africa/Kampala).
-- Enforced in the database so offline phones that sync later cannot add a second one.
-- Only registered students (role_type 'pupil' with a profile) are limited; staff and visitors are not.
--
-- Run once, before this, any existing duplicates must be removed (keep the earliest per student,
-- direction and day), or the index cannot be created.

create unique index if not exists welile_school_gate_logs_one_per_day
  on public.welile_school_gate_logs (profile_id, direction, ((recorded_at at time zone 'Africa/Kampala')::date))
  where profile_id is not null and role_type = 'pupil';
