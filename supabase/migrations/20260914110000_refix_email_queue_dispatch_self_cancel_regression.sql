-- REGRESSION: the self-cancel fix for email_queue_dispatch() shipped earlier
-- today (20260913140000_fix_email_queue_dispatch_self_cancel.sql, confirmed
-- live and confirmed 0 cancellations in the 5 minutes after) was reverted on
-- production sometime before this report's 21:00 UTC snapshot -- the live
-- function body had the old self-disarming
-- `PERFORM cron.unschedule('process-email-queue')` branch back in it. This
-- did NOT come back through any migration file (git log -S on the disarm
-- string only shows the original 2026-04-13 baseline and today's fix
-- commit) -- something applied the old body directly against the database,
-- outside the repo's migration history. 2026-09-13's CTO report shows 12
-- more "job canceled" cancellations between 14:20 and 21:30 UTC, after the
-- first fix landed at ~14:05.
--
-- Re-applying the exact same fix. If this regresses again, the next
-- responder should treat "is this function's live body missing an
-- un-migrated write" as the first question, not re-litigate the fix itself.

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
