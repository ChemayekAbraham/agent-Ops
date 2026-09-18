-- Retiring the daily-cto-report pipeline a second time (first was
-- 20260908150000_remove_daily_cto_report.sql, rebuilt the same day as
-- 20260908160000_fix_cto_report_metrics.sql). See
-- docs/HANDOVER/66-cto-report-2026-09-18-triage.md for what prompted this:
-- documented fixes for this exact metric (mean-vs-median sign-in latency,
-- per mem/features/cto/daily-cto-report.md's 2026-09-08 note) did not hold
-- -- the live RPC verified today still ran a plain AVG() with none of that
-- day's fixes present, no migration recording a revert. Combined with three
-- separate silent regressions of email_queue_dispatch's self-cancel bug
-- (docs 17/18/66) and four prior rounds of this same report fabricating
-- numbers (docs 20, 29, 66), patching the methodology again is not
-- addressing the actual failure mode: fixes applied directly to production
-- do not reliably stay applied, and this report has no way to tell anyone
-- when that's happened to it.
--
-- The edge function `daily-cto-report` (supabase/functions/daily-cto-report)
-- is deleted in this same change. Drop the RPCs it exclusively called
-- (confirmed via repo-wide grep: no frontend page and no other edge
-- function call any of the four), and unschedule every cron job that
-- either sends it or depends on an RPC being dropped here:
--   - daily-cto-report-tech (jobid 10292) and weekly-cto-report-board
--     (jobid 10463) both POST to the daily-cto-report edge function being
--     deleted.
--   - capture-daily-cto-snapshot (jobid 39041, added 2026-09-16 per doc 29,
--     after the first removal/rebuild) calls get_cto_daily_report()
--     directly, not through the edge function -- left running it would
--     start failing daily with "function does not exist" the moment this
--     migration lands.
-- `send-board-memo` is unaffected -- it only sends a human-reviewed
-- PDF/HTML supplied by the caller, it never calls these RPCs.
--
-- db_stat_snapshots itself is left in place (data, not the reporting
-- logic) in case a future rebuild wants the history; nothing else in the
-- codebase reads or writes it once the snapshot-capture job is unscheduled.

drop function if exists public.get_cto_daily_report(date);
drop function if exists public.get_cto_diagnostics(date);
drop function if exists public.get_cto_issue_intelligence(date);
drop function if exists public.get_cto_daily_addendum(date);

do $$
begin
  perform cron.unschedule('daily-cto-report-tech');
exception when others then
  null;
end $$;

do $$
begin
  perform cron.unschedule('weekly-cto-report-board');
exception when others then
  null;
end $$;

do $$
begin
  perform cron.unschedule('capture-daily-cto-snapshot');
exception when others then
  null;
end $$;
