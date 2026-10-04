-- Schedules the tenant notification catalogue's senders.
--
-- All eight edge functions behind the twelve events in tenant_notification_events
-- have shipped unscheduled since Stage 3-6 (see docs/tenant-notification-engine-
-- runbook.md and the 2026-09-09 measurement): "switching one on is a decision
-- with a number behind it," because an unguarded 5-day-default rule would have
-- blasted 558 tenants at once, most of them historical/dormant, not fresh
-- defaults. That guard now lives in code, not in "never schedule it":
--
--   * tenant-default-agent-opportunity has EPISODE_START_FLOOR = 2026-09-09
--     (only default episodes that began on/after go-live are messaged) and a
--     MIN_RUN/MAX_RUN window so the "5 days" framing stays true.
--   * tenant-payment-notices (mode=missed) and tenant-merchant-code-notices
--     both default p_require_prior_payment = true and
--     p_max_days_since_last_payment = 30, excluding the dormant/never-paid
--     population the same measurement flagged.
--   * tenant-rent-limit-notices only messages real credit_limit_change_log
--     rows (RENT_LIMIT_INCREASED) or is itself the honest "no change yet"
--     alternative (RENT_LIMIT_PROGRESS) -- neither can misstate history.
--
-- Confirmed against production tenant_notification_log on 2026-09-16, before
-- this migration: only DASHBOARD_ACTIVATED and DASHBOARD_INVITE had ever
-- fired (both invoked ad hoc, not on a schedule) -- 2 sends, 1 tenant, in the
-- preceding 7 days. See docs/HANDOVER for the corresponding entry.
--
-- Cadence:
--   * PAYMENT_FULL/PAYMENT_PARTIAL (mode=payments) -- every 20 minutes, per
--     the function's own DEFAULT_SWEEP_MINUTES comment ("short sweep, run
--     every few minutes").
--   * PAYMENT_MISSED (mode=missed) -- once daily, after the Kampala
--     obligation day has closed (04:00 UTC = 07:00 EAT).
--   * RENT_LIMIT_INCREASED -- once daily.
--   * RENT_LIMIT_PROGRESS, TENANT_RELOCATION, SMARTPHONE_DISCOVERY,
--     DASHBOARD_INVITE -- all `marketing`, twice weekly (Mon/Thu or Tue/Fri).
--     The governor's global twice-per-rolling-7-days cap is what actually
--     arbitrates when more than one marketing event wants the same tenant;
--     scheduling twice weekly and letting it arbitrate is the design the
--     TENANT_RELOCATION file itself documents.
--   * MERCHANT_CODE_REMINDER, PUSH_MIGRATION -- once daily; both are
--     narrow-population campaigns (unpaid-today, or smartphone+activated-but-
--     no-push-device) that naturally shrink as tenants act.
--
-- DASHBOARD_ACTIVATED is intentionally NOT scheduled here -- it fires from
-- tenant-dashboard-open on a real dashboard visit, not from a sweep.

select cron.schedule(
  'tenant-payment-notices-payments-20min',
  '*/20 * * * *',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-payment-notices',
    headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{"mode":"payments"}'::jsonb
  );
  $$
);

select cron.schedule(
  'tenant-payment-notices-missed-daily',
  '0 4 * * *',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-payment-notices',
    headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{"mode":"missed"}'::jsonb
  );
  $$
);

select cron.schedule(
  'tenant-rent-limit-notices-increased-daily',
  '0 6 * * *',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-rent-limit-notices',
    headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{"mode":"increased"}'::jsonb
  );
  $$
);

select cron.schedule(
  'tenant-rent-limit-notices-progress-biweekly',
  '30 6 * * 1,4',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-rent-limit-notices',
    headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{"mode":"progress"}'::jsonb
  );
  $$
);

select cron.schedule(
  'tenant-merchant-code-notices-daily',
  '0 9 * * *',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-merchant-code-notices',
    headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{}'::jsonb
  );
  $$
);

select cron.schedule(
  'tenant-relocation-notices-biweekly',
  '0 7 * * 1,4',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-relocation-notices',
    headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{}'::jsonb
  );
  $$
);

select cron.schedule(
  'tenant-push-migration-notices-daily',
  '30 7 * * *',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-push-migration-notices',
    headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{}'::jsonb
  );
  $$
);

select cron.schedule(
  'tenant-default-agent-opportunity-daily',
  '0 5 * * *',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-default-agent-opportunity',
    headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{}'::jsonb
  );
  $$
);

select cron.schedule(
  'tenant-dashboard-invites-discovery-biweekly',
  '0 8 * * 2,5',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-dashboard-invites',
    headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{"mode":"discovery"}'::jsonb
  );
  $$
);

select cron.schedule(
  'tenant-dashboard-invites-invite-biweekly',
  '15 8 * * 2,5',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-dashboard-invites',
    headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{"mode":"invite"}'::jsonb
  );
  $$
);
