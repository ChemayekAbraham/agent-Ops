-- Rollback for 20261012100000_am_plan_clock_and_arrears.sql
-- Both functions are new and read-only; dropping them changes no data.
DROP FUNCTION IF EXISTS public.am_plan_arrears(uuid[], date);
DROP FUNCTION IF EXISTS public.am_plan_clock(uuid[]);
