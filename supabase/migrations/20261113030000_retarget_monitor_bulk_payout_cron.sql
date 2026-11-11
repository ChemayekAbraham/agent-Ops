-- Retarget cron job 475 (monitor-bulk-payout-stuck-every-15-min) off the missing
-- monitor-bulk-payout-stuck slug. The job was posting there every 15 minutes
-- and receiving HTTP 404. Nothing else cron-invokes the live replacement,
-- reconcile-bulk-bank-payout-stuck, which is safe to re-run.
--
-- The previous command also embedded a literal anon JWT in headers.apikey.
-- This migration does not copy that command, and it does not put a secret,
-- JWT, or service-role key in SQL. The wrapper reads vault secret
-- email_queue_service_role_key at run time and sends it as Authorization
-- Bearer, the same way email_queue_dispatch() calls process-email-queue.
--
-- The job is not unscheduled and is not renamed. Schedule, database,
-- username, and active are left unchanged. The DO block refuses to alter
-- the job unless it is still active and its command still targets the old slug.
-- It checks that with position() only and never raises the command text.

CREATE OR REPLACE FUNCTION public.invoke_reconcile_bulk_bank_payout_stuck()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_service_key text;
BEGIN
  SELECT decrypted_secret INTO v_service_key
  FROM vault.decrypted_secrets
  WHERE name = 'email_queue_service_role_key'
  LIMIT 1;

  IF v_service_key IS NULL THEN
    RAISE WARNING 'invoke_reconcile_bulk_bank_payout_stuck: service credential not available; skipping run';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/reconcile-bulk-bank-payout-stuck',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body := jsonb_build_object(
      'source', 'pg_cron',
      'at', now(),
      'scheduled_at', now()
    )
  );
END;
$function$;

-- Default privileges grant EXECUTE to anon and authenticated. This wrapper
-- reads a vault credential, so those roles must not keep it. postgres (the
-- cron user) and service_role may execute it.
REVOKE ALL ON FUNCTION public.invoke_reconcile_bulk_bank_payout_stuck() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_reconcile_bulk_bank_payout_stuck() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_reconcile_bulk_bank_payout_stuck() TO postgres, service_role;

DO $do$
DECLARE
  v_command text;
  v_active boolean;
BEGIN
  SELECT command, active
    INTO v_command, v_active
  FROM cron.job
  WHERE jobid = 475
    AND jobname = 'monitor-bulk-payout-stuck-every-15-min';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'refusing to alter cron job 475: missing row or jobname is not monitor-bulk-payout-stuck-every-15-min';
  END IF;

  IF v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'refusing to alter cron job 475: job is not active';
  END IF;

  IF v_command IS NULL
     OR position('/functions/v1/monitor-bulk-payout-stuck' IN v_command) = 0 THEN
    RAISE EXCEPTION 'refusing to alter cron job 475: command does not target monitor-bulk-payout-stuck';
  END IF;

  PERFORM cron.alter_job(
    job_id := 475,
    command := 'SELECT public.invoke_reconcile_bulk_bank_payout_stuck();'
  );
END;
$do$;
