-- 2026-09-12 Daily CTO Report: automation "(unscheduled) email_queue_dispatch"
-- failing with "job canceled" (36 failures in 24h, 121 since 2026-09-06 per
-- cron.job_run_details, all sub-40ms). Emails are unaffected (0 failed today,
-- 100% notification delivery) because the failure happens on the *empty
-- queue* branch, after any real work is already done.
--
-- Root cause: public.email_queue_dispatch() is itself the command behind the
-- 'process-email-queue' cron job (scheduled by email_queue_wake() on the
-- first enqueue). When it finds both pgmq queues empty, it calls
--   PERFORM cron.unschedule('process-email-queue');
-- from *inside* that same job's own execution. pg_cron cancels a job's
-- active background worker the moment its cron.job row is deleted, so the
-- dispatcher cancels itself and pg_cron logs the run as failed with
-- "job canceled" -- a self-inflicted, cosmetic failure, not a real one.
--
-- Fix: stop self-disarming. Once armed, 'process-email-queue' just keeps
-- polling every 5 seconds forever; each empty-queue check costs ~4ms
-- (observed in cron.job_run_details), i.e. ~17k negligible checks/day.
-- email_queue_wake() already re-arms it if it were ever gone, so removing
-- the disarm path is a pure behavior subset -- no functional change to email
-- delivery, just no more self-cancellation noise in automation monitoring.
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
