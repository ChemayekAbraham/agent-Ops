-- Rollback for 20261013160000_tenant_ops_weekly_amclock.sql
-- Removes the new functions and the new cron job. The new snapshot table is KEPT (it holds weeks that
-- were frozen the new way; dropping it would lose them). Nothing existing is touched: the old functions,
-- views, cron job and tenant_ops_weekly_metrics were never edited by the migration.
DO $rb$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'pin-tenant-ops-weekly-metrics-amclock-eat-wed';
  END IF;
END
$rb$;

DROP FUNCTION IF EXISTS public.get_tenant_ops_weekly_performance_amclock(date);
DROP FUNCTION IF EXISTS public.get_tenant_ops_weekly_history_amclock(integer);
DROP FUNCTION IF EXISTS public.pin_tenant_ops_weekly_metrics_amclock_catchup(integer);
DROP FUNCTION IF EXISTS public.pin_tenant_ops_weekly_metrics_amclock(date);
DROP FUNCTION IF EXISTS public._tenant_ops_weekly_amclock_week(date, date);
DROP FUNCTION IF EXISTS public._tenant_ops_weekly_metrics_raw_amclock(date, date);
DROP FUNCTION IF EXISTS public._tenant_ops_weekly_amclock_plans(date, date);
DROP FUNCTION IF EXISTS public._tenant_ops_weekly_amclock_first_week();
