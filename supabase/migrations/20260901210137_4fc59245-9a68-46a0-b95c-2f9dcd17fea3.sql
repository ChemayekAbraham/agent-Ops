select cron.schedule(
  'tenant-rent-intake-notices-15min',
  '*/15 * * * *',
  $$select net.http_post(
      url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-rent-intake-notices',
      headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
      body:='{}'::jsonb
  );$$
);