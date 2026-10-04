-- Retiring the daily-cto-report pipeline: the health-score/KPI methodology
-- produced misleading numbers (e.g. absolute "backup status" reused across a
-- 7-day rollup, cumulative pg_stat_statements counters read as "today's"
-- activity, automation "failures" that were really benign duplicate-tick
-- retries). Rather than patch the scoring further, the RPCs and the edge
-- function that renders/emails them are being removed so a replacement can
-- be built on corrected definitions instead of inheriting this one's drift.
--
-- The edge function `daily-cto-report` (supabase/functions/daily-cto-report)
-- is deleted in this same change; drop the RPCs it exclusively called, and
-- unschedule its cron job. `send-board-memo` is unaffected — it only sends a
-- human-reviewed PDF supplied by the caller, it never calls these RPCs.

drop function if exists public.get_cto_daily_report(date);
drop function if exists public.get_cto_diagnostics(date);
drop function if exists public.get_cto_issue_intelligence(date);
drop function if exists public.get_cto_daily_addendum(date);

do $$
begin
  perform cron.unschedule('daily-cto-report');
exception when others then
  null; -- job name may differ or already be gone; nothing to do
end $$;
