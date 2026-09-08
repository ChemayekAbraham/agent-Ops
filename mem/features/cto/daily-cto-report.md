---
name: Daily CTO Report
description: REMOVED 2026-09-08 — health-score methodology was misleading; RPCs and edge function deleted, replacement pending
type: feature
---
- Removed 2026-09-08 (`20260908150000_remove_daily_cto_report.sql`): dropped RPCs `get_cto_daily_report`, `get_cto_diagnostics`, `get_cto_issue_intelligence`, `get_cto_daily_addendum` (all SECURITY DEFINER, p_date date), deleted edge fn `supabase/functions/daily-cto-report`, unscheduled cron job `daily-cto-report` (was `0 21 * * *` UTC = 00:00 EAT).
- Reason: the weighted 0-100 health score and several dashboard figures didn't measure what they claimed — e.g. the weekly board-memo rollup reused a single day's backup status for all 7 days (fixed once in `20260907190000` but the underlying pattern of stat mixing recurred elsewhere), pg_stat_statements' cumulative call counters were presented as same-day activity, and automations with fast retry schedules (e.g. `*/2 * * * *`) counted a single transient tick failure the same as a persistent outage.
- `send-board-memo` is unaffected — it only relays a human-reviewed PDF/HTML supplied by the caller and never called these RPCs itself; it was only coupled by a shared recipient constant.
- Replacement not yet built. Before rebuilding, decide per-metric what "today" and "failure" actually mean (point-in-time delta vs. cumulative counter vs. retry-tolerant automation), rather than reusing this version's aggregation as a starting point.
