
-- Extend alert types to allow Gmail auth failure alerts
ALTER TABLE public.deposit_match_alerts DROP CONSTRAINT deposit_match_alerts_alert_type_check;
ALTER TABLE public.deposit_match_alerts ADD CONSTRAINT deposit_match_alerts_alert_type_check
  CHECK (alert_type = ANY (ARRAY['deposit_unmatched'::text, 'email_receipt_unmatched'::text, 'gmail_auth_failure'::text]));

-- Reschedule Gmail poll from every minute to every 2 minutes
DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'gmail-poll-transactions-every-minute';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'gmail-poll-transactions-every-2min';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'gmail-poll-transactions-every-2min',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/gmail-poll-transactions',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body := jsonb_build_object('scheduled_at', now())
  );
  $$
);
