-- Email Josh (CC the CEO, benjamin@welile.com) a plain-English summary of what
-- the engineers shipped, every evening at 18:00 Africa/Kampala (15:00 UTC).
-- Recipients are fixed inside the edge function. DO NOT APPLY until the test
-- email (dry_run / to=[Josh]) has been read and approved, and the GITHUB_TOKEN
-- secret exists on the edge function.
DO $cron$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'daily-engineering-update-report-1800-eat';
END
$cron$;

SELECT cron.schedule(
  'daily-engineering-update-report-1800-eat',
  '0 15 * * *',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/daily-engineering-update-report',
    headers:='{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{}'::jsonb
  ) as request_id;
  $$
);
