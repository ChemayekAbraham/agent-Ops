-- Author: SSENKAALI PIUS
-- Email: ssenkaali.pius@welileapp.com
-- Date: 2026-11-13
-- Website: welileapp.com
--
-- Rollback of 20261121140000_direct_pay_phase7_health.sql. Re-runnable; nothing to refuse (no data).

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron')
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'direct-pay-health') THEN
    PERFORM cron.unschedule('direct-pay-health');
  END IF;
END
$cron$;
DROP FUNCTION IF EXISTS public.direct_pay_health_alert();
DROP FUNCTION IF EXISTS public.direct_pay_health();
DROP FUNCTION IF EXISTS public._direct_pay_health_core();
