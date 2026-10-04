-- 2026-09-11 Daily CTO Report, Infrastructure Alerts: "Transaction rollback
-- rate: Unavailable ... No trustworthy same-day snapshot pair exists yet —
-- restore the daily db_stat_snapshots capture."
--
-- public.get_cto_daily_report() (20260909063711_fix_cto_report_automation_
-- and_rollback_fabrication.sql) only inserts today's row into
-- public.db_stat_snapshots as a side effect of being CALLED for p_date =
-- today. Nothing schedules that call — it only happens when a human opens
-- the CTO dashboard that day. Miss a day (nobody looks, or looks only after
-- midnight EAT) and public.db_stat_snapshots has a gap, which breaks the
-- v_prev_day = p_date - 1 trustworthiness check for every following day
-- until the dashboard happens to be opened twice in a row. This is exactly
-- the "Unavailable" rollback rate / deadlock delta the report is flagging.
--
-- Fix: schedule the snapshot capture directly, independent of dashboard
-- traffic. get_cto_daily_report() authorizes cron/service-role callers via
-- its `auth.uid() IS NULL` branch, so no privilege change is needed.
-- Scheduled at 23:55 EAT (20:55 UTC) so the captured cumulative counters
-- reflect nearly the full Kampala day before it rolls over.

SELECT cron.unschedule('capture-daily-cto-snapshot')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'capture-daily-cto-snapshot');

SELECT cron.schedule(
  'capture-daily-cto-snapshot',
  '55 20 * * *',
  $$SELECT public.get_cto_daily_report();$$
);
