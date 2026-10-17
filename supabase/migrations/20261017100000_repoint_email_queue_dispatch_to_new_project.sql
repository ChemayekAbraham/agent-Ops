-- Repoint email_queue_dispatch() at the new Supabase project (PDPO cutover).
--
-- After the 2026-10-17 cutover the dispatcher still posted to the old project
-- host (wirntoujqoyjobfhyelc), which no longer resolves. cron job
-- process-email-queue reported "succeeded" every 5s while net.http_post went
-- nowhere, so the transactional queue stopped draining at 07:09 UTC (2FA codes
-- never delivered). The stored canonical_body in critical_function_baselines
-- carried the same old URL, so the drift scanner (auto_remediate = true) would
-- have restored it. The function, canonical_body and expected_sha256 are
-- therefore changed together here.
--
-- Already applied to production by hand via execute_sql on 2026-10-17 07:33 UTC
-- (apply_migration failed on schema_migrations ON CONFLICT). Idempotent.

CREATE OR REPLACE FUNCTION public.email_queue_dispatch()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pgmq.q_auth_emails)
     AND NOT EXISTS (SELECT 1 FROM pgmq.q_transactional_emails) THEN
    RETURN;
  END IF;

  IF (SELECT retry_after_until FROM public.email_send_state WHERE id = 1) > now() THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/process-email-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Lovable-Context', 'cron',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key'
      )
    ),
    body := '{}'::jsonb
  );
END;
$function$;

-- Derive from the live function, never type it by hand (see 20260922070000).
UPDATE public.critical_function_baselines
SET canonical_body = pg_get_functiondef('public.email_queue_dispatch()'::regprocedure),
    expected_sha256 = encode(
      sha256(convert_to(pg_get_functiondef('public.email_queue_dispatch()'::regprocedure), 'UTF8')),
      'hex'
    ),
    baselined_at = now(),
    baselined_by = '20261017100000_repoint_email_queue_dispatch_to_new_project.sql',
    note = 'PDPO cutover (2026-10-17): dispatch URL repointed from old project wirntoujqoyjobfhyelc to byrzshwlentqvktcksem. Old URL left the transactional queue undrained from 07:09 UTC. canonical_body and hash updated together so auto-remediation does not revert it.'
WHERE function_signature = 'email_queue_dispatch()';

UPDATE public.critical_function_drift_alerts
SET resolved_at = now()
WHERE function_signature = 'email_queue_dispatch()' AND resolved_at IS NULL;
