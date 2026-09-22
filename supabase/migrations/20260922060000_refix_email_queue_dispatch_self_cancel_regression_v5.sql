-- Sixth occurrence of the email_queue_dispatch self-cancel regression (see
-- docs/HANDOVER/18, 66 §1, 84 §1, 88 §1 for the first four; this is the fifth
-- regression since doc 88's fix, detected by the drift scanner at 2026-09-21
-- 06:30 UTC -- about 90 minutes after doc 88's fix was verified live -- and
-- left unresolved for roughly 24 hours until this migration.
--
-- Verified live 2026-09-22: pg_get_functiondef showed the exact same
-- advisory-lock-guarded cron.unschedule-from-inside-itself body as the
-- third/fourth/fifth regressions, and cron.job had zero rows for
-- 'process-email-queue'. get_cto_diagnostics('2026-09-21') showed 12
-- failures / 1,461 runs in 24h with exception 'job canceled' -- the function
-- kept getting invoked (via email_queue_wake()'s inline dispatch on every
-- enqueue, not cron, since cron had nothing scheduled) and about 1 in 122
-- of those invocations hit the self-cancel race and threw.
--
-- Reapplying doc 18 Fix #1 for the fifth time: never self-disarm. Once
-- armed, process-email-queue keeps polling every 5 seconds indefinitely.
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
    url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/process-email-queue',
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

SELECT cron.schedule('process-email-queue', '5 seconds', $cron$ SELECT public.email_queue_dispatch(); $cron$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-email-queue');

UPDATE public.critical_function_baselines
SET expected_sha256 = encode(
      sha256(convert_to(pg_get_functiondef('public.email_queue_dispatch()'::regprocedure), 'UTF8')),
      'hex'
    ),
    baselined_at = now(),
    baselined_by = '20260922060000_refix_email_queue_dispatch_self_cancel_regression_v5.sql',
    note = 'Sixth self-cancel regression (2026-09-22, drift alert opened 2026-09-21 06:30 UTC and sat unresolved ~24h): live body had reverted to the same advisory-lock-guarded cron.unschedule as the third/fourth/fifth regressions. Reapplied doc-18 Fix #1, re-armed the job, rebaselined in the same statement batch.'
WHERE function_signature = 'email_queue_dispatch()';

UPDATE public.critical_function_drift_alerts
SET resolved_at = now()
WHERE function_signature = 'email_queue_dispatch()' AND resolved_at IS NULL;
