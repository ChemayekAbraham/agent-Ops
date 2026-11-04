-- Rollback for 20261104190000_staff_assistant_model_drift_check.sql
DROP FUNCTION IF EXISTS public.staff_assistant_check_model_drift(integer);
