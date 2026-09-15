-- Promissory note reminders for proxy agents: Mon / Wed / Fri, 09:00 EAT.
--
-- 06:00 UTC is 09:00 in Kampala. Working hours, never a weekend, and early
-- enough that an agent can act on it the same day.
--
-- Three mornings a week rather than daily: 64 notes sit with 35 agents and the
-- oldest are weeks old, so a daily text would say the same thing five times
-- before anything could plausibly change, and be ignored by the second week.
--
-- The function sends ONE message per agent regardless of how many notes they
-- hold (one agent holds twelve), skips notes younger than 48 hours, and skips
-- agents who recorded a follow-up in the last seven days.

SELECT cron.unschedule('proxy-promissory-note-reminders-0900-eat')
 WHERE EXISTS (
   SELECT 1 FROM cron.job WHERE jobname = 'proxy-promissory-note-reminders-0900-eat'
 );

SELECT cron.schedule(
  'proxy-promissory-note-reminders-0900-eat',
  '0 6 * * 1,3,5',
  $$
  SELECT net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/proxy-promissory-note-reminders',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{}'::jsonb
  ) AS request_id;
  $$
);
