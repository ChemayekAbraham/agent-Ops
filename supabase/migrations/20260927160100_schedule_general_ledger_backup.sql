-- Back up public.general_ledger every night at 01:00 Africa/Kampala (22:00 UTC)
-- and email the links to joshwanda17@gmail.com (recipient is fixed in the
-- general-ledger-backup-ready template). Apply only after the
-- general-ledger-backup edge function is deployed and a manual run verified.
DO $cron$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'general-ledger-backup-0100-eat';
END
$cron$;

SELECT cron.schedule(
  'general-ledger-backup-0100-eat',
  '0 22 * * *',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/general-ledger-backup',
    headers:='{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{}'::jsonb,
    timeout_milliseconds:=300000
  ) as request_id;
  $$
);
