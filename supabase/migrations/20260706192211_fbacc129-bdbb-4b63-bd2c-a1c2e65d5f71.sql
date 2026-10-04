-- Schedule the Welile Homes SMS receipt dispatcher every 5 minutes.
-- It scans recent rent-collection and landlord-payout events and sends
-- (idempotent) SMS receipts. Covers agent allocations, tenant deposit
-- auto-collections, and the daily landlord payout run.
SELECT cron.schedule(
  'welile-homes-sms-dispatch',
  '*/5 * * * *',
  $$SELECT net.http_post(
      url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/welile-homes-sms-dispatch',
      headers:='{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
      body:='{"since_minutes":15}'::jsonb
    );$$
);