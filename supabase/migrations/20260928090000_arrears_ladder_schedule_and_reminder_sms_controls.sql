-- Arrears ladder on a schedule + config-driven reminder SMS controls.
-- Benjamin's standing clear (2026-09-28 07:50 EAT) for templated, rate-capped
-- reminder SMS to our own tenants and agents: missed day -> day 3 agent ->
-- day 7 call task, with a kill switch.
--
-- 1. system_config keys read by supabase/functions/_shared/reminderSmsControls.ts
--    (used by tenant-arrears-escalations and tenant-payment-notices mode=missed):
--      reminder_sms_enabled                 true  kill switch; missing row = OFF
--      reminder_sms_max_per_tenant_per_day  1     across arrears + PAYMENT_MISSED
--      reminder_sms_max_per_run             400   per function run, largest arrears first
--    ON CONFLICT DO NOTHING: re-running this never overwrites a value someone
--    has already changed. Turning reminders off is one row:
--      update public.system_config set value = 'false'::jsonb, updated_at = now()
--       where key = 'reminder_sms_enabled';
--
-- 2. Schedules tenant-arrears-escalations daily at 04:30 UTC = 07:30 EAT:
--    after the 00:05 EAT bill pin, and 30 minutes after PAYMENT_MISSED
--    (tenant-payment-notices-missed-daily, 04:00 UTC). With the 1-per-tenant
--    daily cap a tenant who got PAYMENT_MISSED at 07:00 is not texted again
--    by the ladder at 07:30; the ladder's agent SMS/tasks and day-7 call rows
--    still run.
--
--    Headers carry the public anon key as both apikey and Authorization
--    Bearer: the function has no config.toml verify_jwt=false entry (default
--    true), and an apikey-only call is refused by the gateway when
--    verify_jwt is on (docs/HANDOVER/79).
--
--    Lovable's project memory (mem/features/tenant/arrears-escalation-ladder.md)
--    names a job `tenant-arrears-escalations-0700-eat` (0 4 * * *) that is not
--    in any repo migration. If it exists in production it is replaced here, so
--    there is exactly one arrears job and it runs after PAYMENT_MISSED.
--
-- Rollback:
--   select cron.unschedule('tenant-arrears-escalations-daily-0730-eat');
--   (and/or set reminder_sms_enabled = false; keys are inert without senders)

insert into public.system_config (key, value) values
  ('reminder_sms_enabled', 'true'::jsonb),
  ('reminder_sms_max_per_tenant_per_day', '1'::jsonb),
  ('reminder_sms_max_per_run', '400'::jsonb)
on conflict (key) do nothing;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'tenant-arrears-escalations-0700-eat') then
    perform cron.unschedule('tenant-arrears-escalations-0700-eat');
  end if;
  if exists (select 1 from cron.job where jobname = 'tenant-arrears-escalations-daily-0730-eat') then
    perform cron.unschedule('tenant-arrears-escalations-daily-0730-eat');
  end if;
end
$$;

select cron.schedule(
  'tenant-arrears-escalations-daily-0730-eat',
  '30 4 * * *',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-arrears-escalations',
    headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:='{}'::jsonb
  );
  $$
);
