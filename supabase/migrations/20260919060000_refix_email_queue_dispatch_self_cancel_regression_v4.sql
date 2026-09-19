-- Fourth occurrence of the email_queue_dispatch self-cancel regression (see
-- docs/HANDOVER/18-email-queue-dispatch-self-cancel-regression.md for the
-- first two, docs/HANDOVER/66-cto-report-2026-09-18-triage.md §1 for the
-- third). The 2026-09-18 fix (migration 20260918000000) was confirmed live
-- and re-baselined at 2026-09-18 06:26:57 UTC, but a new drift alert opened
-- 19 minutes later (2026-09-18 06:45:00 UTC) and sat unresolved and
-- un-actioned again. Verified live 2026-09-19: the function body has
-- reverted to the exact same advisory-lock-guarded disarm variant as the
-- third regression -- and this time it actually completed, because
-- `cron.job` had zero rows for 'process-email-queue' at time of writing.
-- The dispatcher is not currently running on any schedule at all.
--
-- Still cosmetic, not a delivery failure: both pgmq queues
-- (q_auth_emails, q_transactional_emails) are confirmed empty, and
-- email_queue_wake() (unchanged, still correct) re-arms the cron job AND
-- fires process-email-queue directly on every enqueue -- so nothing is
-- silently stuck right now. But zero background polling means any email
-- that fails email_queue_wake()'s inline dispatch (e.g. a transient
-- net.http_post error) has no fallback until the next enqueue.
--
-- Reapplying doc 18 Fix #1 for the fourth time: never self-disarm. Once
-- armed, process-email-queue keeps polling every 5 seconds indefinitely;
-- each empty-queue check costs ~4ms observed. No advisory-lock cleverness
-- needed since there is no disarm path left to race against.
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

-- The job itself is currently unscheduled (self-cancel completed this time,
-- unlike the third regression where the advisory-lock guard prevented it
-- from ever fully succeeding). Re-arm it directly rather than wait for the
-- next enqueue to trigger email_queue_wake().
SELECT cron.schedule('process-email-queue', '5 seconds', $cron$ SELECT public.email_queue_dispatch(); $cron$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-email-queue');

-- Re-baseline immediately per doc 17's standing instruction, so drift
-- detection stops firing on our own deliberate fix and can catch the next
-- silent revert.
UPDATE public.critical_function_baselines
SET expected_sha256 = encode(
      sha256(convert_to(pg_get_functiondef('public.email_queue_dispatch()'::regprocedure), 'UTF8')),
      'hex'
    ),
    baselined_at = now(),
    baselined_by = '20260919060000_refix_email_queue_dispatch_self_cancel_regression_v4.sql',
    note = 'Fourth self-cancel regression (2026-09-19): live body had reintroduced the same advisory-lock-guarded cron.unschedule as the third regression, and this time it completed -- process-email-queue had zero rows in cron.job. No migration recorded the change (git log -S on the disarm string only shows the four documented fixes). Reapplied doc-18 Fix #1, re-armed the job directly, and rebaselined in the same migration.'
WHERE function_signature = 'email_queue_dispatch()';

UPDATE public.critical_function_drift_alerts
SET resolved_at = now()
WHERE function_signature = 'email_queue_dispatch()' AND resolved_at IS NULL;
