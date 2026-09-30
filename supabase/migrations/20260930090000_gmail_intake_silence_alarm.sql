-- Silence alarm for the MoMo SMS -> IFTTT -> Gmail deposit-intake chain (doc 170).
--
-- 1. Config table (singleton) for the new gmail-intake-silence-alarm function.
-- 2. deposit_match_alerts.alert_type check: the live constraint had lost
--    'gmail_poll_stale' (20260926090000 rebuilt the list without it), so the
--    existing gmail-poll-heartbeat could never write its alert. Restore it and
--    add 'gmail_intake_silent'.
-- 3. Schedule the silence alarm every 10 minutes, and re-schedule the
--    gmail-poll-heartbeat cron, which was not present in production.

CREATE TABLE IF NOT EXISTS public.gmail_intake_silence_config (
  id integer PRIMARY KEY DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  threshold_minutes integer NOT NULL DEFAULT 45,
  renotify_minutes integer NOT NULL DEFAULT 60,
  active_start_hour_eat integer NOT NULL DEFAULT 6,
  active_end_hour_eat integer NOT NULL DEFAULT 23,
  notify_emails text[] NOT NULL DEFAULT ARRAY['joshua.wanda@welile.com','benjamin@welile.com']::text[],
  -- Empty until set: the alarm is email-only until phone numbers are added.
  notify_sms_phones text[] NOT NULL DEFAULT ARRAY[]::text[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gmail_intake_silence_config_singleton CHECK (id = 1),
  CONSTRAINT gmail_intake_silence_config_threshold CHECK (threshold_minutes BETWEEN 10 AND 1440),
  CONSTRAINT gmail_intake_silence_config_hours CHECK (
    active_start_hour_eat BETWEEN 0 AND 23 AND active_end_hour_eat BETWEEN 0 AND 24)
);
ALTER TABLE public.gmail_intake_silence_config ENABLE ROW LEVEL SECURITY;
INSERT INTO public.gmail_intake_silence_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.deposit_match_alerts
  DROP CONSTRAINT IF EXISTS deposit_match_alerts_alert_type_check;
ALTER TABLE public.deposit_match_alerts
  ADD CONSTRAINT deposit_match_alerts_alert_type_check
  CHECK (alert_type = ANY (ARRAY[
    'deposit_unmatched'::text,
    'email_receipt_unmatched'::text,
    'gmail_auth_failure'::text,
    'gmail_poll_stale'::text,
    'gmail_intake_silent'::text,
    'merchant_float_uncredited'::text,
    'merchant_float_return'::text
  ]));

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid FROM cron.job
           WHERE jobname IN ('gmail-intake-silence-alarm-every-10min', 'gmail-poll-heartbeat-every-15min')
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'gmail-intake-silence-alarm-every-10min',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/gmail-intake-silence-alarm',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8'
    ),
    body := jsonb_build_object('scheduled_at', now())
  );
  $$
);

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
