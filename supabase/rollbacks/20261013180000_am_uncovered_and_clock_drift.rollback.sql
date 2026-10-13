-- Rollback for 20261013180000_am_uncovered_and_clock_drift.sql
-- Removes the new functions, the append-only guard triggers and the cron job. The two drift tables are KEPT
-- (they are an append-only record; dropping them would lose it). Nothing existing was edited by the migration.
DO $rb$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'am-clock-drift-daily-0600-eat';
  END IF;
END
$rb$;

DROP FUNCTION IF EXISTS public.get_am_clock_drift_status();
DROP FUNCTION IF EXISTS public.am_detect_clock_drift(date);
DROP FUNCTION IF EXISTS public.am_uncovered_plans(date, integer, integer);
DROP FUNCTION IF EXISTS public._am_plan_arrears_core(uuid[], date);
DROP TRIGGER IF EXISTS am_clock_drift_daily_append_only ON public.am_clock_drift_daily;
DROP TRIGGER IF EXISTS am_clock_drift_runs_append_only ON public.am_clock_drift_runs;
DROP FUNCTION IF EXISTS public._am_clock_drift_append_only();
