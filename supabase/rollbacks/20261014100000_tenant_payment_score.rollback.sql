-- Rollback for 20261014100000_tenant_payment_score.sql
-- Stops the nightly job and drops the functions. Nothing existing was edited by the migration, so nothing else needs
-- restoring. The snapshot table tenant_payment_score_daily (and its append-only triggers and function) is KEPT, as the
-- earlier snapshot rollbacks keep theirs: it is append-only history and must not be lost by a rollback. To remove it
-- as well, run the last block deliberately (the append-only trigger does not stop DROP TABLE).
DO $rb$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'tenant-payment-score-daily-0045-eat';
  END IF;
END
$rb$;
DROP FUNCTION IF EXISTS public.tenant_payment_score_run(date);
DROP FUNCTION IF EXISTS public.tenant_payment_score(uuid[]);
DROP FUNCTION IF EXISTS public._tenant_payment_score_core(uuid[], date);
DROP FUNCTION IF EXISTS public._tps_label(integer, text);

-- Optional, only when the stored scores are to be thrown away as well:
-- DROP TABLE IF EXISTS public.tenant_payment_score_daily;
-- DROP FUNCTION IF EXISTS public._tenant_payment_score_append_only();
