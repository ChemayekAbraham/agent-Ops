-- Rollback for 20261106120000_staff_mfa_force_enrol_date.sql.
-- Faster, non-destructive: select public.set_staff_mfa_force_enrol(null, 'switching the forced enrol step off');
drop function if exists public.set_staff_mfa_force_enrol(timestamptz, text);
alter table public.staff_mfa_config drop column if exists force_enrol_from;
-- my_staff_mfa_status: re-run its definition from 20261022130000_staff_mfa_phase2_function_checks.sql or the previous
-- migration that last defined it (it simply has no force_enrol keys); the app treats a missing force_enrol as false.
