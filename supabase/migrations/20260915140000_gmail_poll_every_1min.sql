-- Reduce the Gmail-poll cron cadence from every 2 minutes to every 1 minute
-- (pg_cron's minimum granularity). Requested after a production latency
-- audit (2026-09-15) found the poller itself was fast (median ~40s / p95
-- ~2min from Gmail-received to credited) but the OVERALL money-sent-to-
-- credited time had a long tail dominated by IFTTT's own SMS-forwarding
-- delay (p95 ~40min, max ~63min — consistent with IFTTT's free-tier
-- ~hourly trigger-check cadence, which this migration does not and cannot
-- fix; that requires an IFTTT plan/config change or replacing IFTTT with a
-- push-based forwarder). Halving the poll interval only shaves the small
-- portion of the delay that is actually Welile's — applied directly to
-- production via `cron.unschedule` + `cron.schedule` on 2026-09-15; this
-- migration exists so the repo reflects the live cron configuration.

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'gmail-poll-transactions-every-2min';

SELECT cron.schedule(
  'gmail-poll-transactions-every-1min',
  '*/1 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/gmail-poll-transactions',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body := jsonb_build_object('scheduled_at', now())
  );
  $$
)
WHERE NOT EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'gmail-poll-transactions-every-1min'
);
