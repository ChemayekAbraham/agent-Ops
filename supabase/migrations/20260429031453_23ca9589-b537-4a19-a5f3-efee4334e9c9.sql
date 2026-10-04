
DO $$
BEGIN
  PERFORM cron.unschedule('apply-payroll-growth-daily');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'apply-payroll-growth-daily',
  '0 0 * * *',
  $$
  SELECT net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/apply-payroll-growth',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:=concat('{"trigger":"cron","time":"', now(), '"}')::jsonb
  ) as request_id;
  $$
);
