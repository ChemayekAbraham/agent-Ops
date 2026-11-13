-- Rollback of 20261115140000_fin_daily_tieout.sql (reporting only; drops the tie-out history).
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'fin-daily-tieout';
  END IF;
END
$do$;
DROP FUNCTION IF EXISTS public.fin_run_daily_tieout(text);
DROP TABLE IF EXISTS public.fin_daily_tieout;
DROP TABLE IF EXISTS public.fin_daily_tieout_settings;
