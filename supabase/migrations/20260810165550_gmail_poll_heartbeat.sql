-- Heartbeat for the Gmail/IFTTT deposit-intake pipeline.
--
-- gmail-poll-transactions already raises a 'gmail_auth_failure' alert when
-- it runs and hits a 401/403, but nothing watches for the cron job itself
-- going silent (unscheduled, pg_cron outage, platform issue) — that class
-- of failure previously had zero automated signal; someone had to open
-- Financial Ops -> Email Transactions and notice a stale timestamp. The
-- new gmail-poll-heartbeat function checks gmail_poll_state independently
-- on its own schedule and alerts if no poll has succeeded recently.

-- Must be its own statement, no transaction wrapping.
ALTER TYPE public.system_event_type ADD VALUE IF NOT EXISTS 'gmail_poll_heartbeat_alert';

ALTER TABLE public.deposit_match_alerts DROP CONSTRAINT deposit_match_alerts_alert_type_check;
ALTER TABLE public.deposit_match_alerts ADD CONSTRAINT deposit_match_alerts_alert_type_check
  CHECK (alert_type = ANY (ARRAY[
    'deposit_unmatched'::text,
    'email_receipt_unmatched'::text,
    'gmail_auth_failure'::text,
    'gmail_poll_stale'::text
  ]));

DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'gmail-poll-heartbeat-every-15min';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'gmail-poll-heartbeat-every-15min',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/gmail-poll-heartbeat',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8'
    ),
    body := jsonb_build_object('scheduled_at', now())
  );
  $$
);
