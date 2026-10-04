# 29. Fix — Daily CTO Report and Board Technology Memo fabrications (2026-09-16)

**Status: fixed, verified live in production.** Prompted by the user asking whether the
2026-09-15 Daily CTO Report and week-ending-2026-09-15 Board Technology Memo PDFs were accurate.
They were not — four separate, self-contradictory fabrications, found by verifying against live
production Postgres rather than trusting the repo's migration history (see
[`06-live-state-verification.md`](./06-live-state-verification.md) and
[`project_repo_migrations_diverge_from_production`] pattern: one of the fixes below had *already*
been written as a migration on 2026-09-12 and simply never actually applied to production).

---

## The four bugs

### 1. Authentication Diagnostics counted successful checkpoints as sign-in failures

`get_cto_diagnostics()`'s `failure_breakdown` query counted every `public.login_phase_events` row
with `status <> 'success'` as a sign-in failure. Only `phase = 'auth.signin.attempt'` actually uses
the literal string `'success'` — every other auth-pipeline checkpoint phase
(`auth.enforceAccountAccess.end`, `gate.account_frozen.check`, `gate.name_completion.check.end`,
`gate.phone_collection.check.end`, `auth.getSession.end`, `guard.resolved`) reports its own success
as `status = 'ok'`.

On 2026-09-15 this miscounted ~26,500 routine, successful "ok" checkpoint events as sign-in
failures — the report's "Authentication Diagnostics" table implied ~28,000 failures in the same
PDF whose own dashboard tile (correctly phase-scoped) said 58 failures / 85.5% success.

**Fix:** exclude `'ok'` alongside `'success'` in the `failure_breakdown` subquery.

### 2. Slow-query severity was never actually capped, despite a comment claiming it was

`get_cto_issue_intelligence()`'s slow-query classifier still ran
`CASE WHEN mean_exec_time > 2000 THEN 'Critical' ...` — `pg_stat_statements` is a
lifetime-cumulative counter (no daily reset), so this labels chronic, 32–210-day-old statements as
same-day fires. `daily-cto-report/index.ts` already carries a comment (from the 2026-09-09 fix
documented in `mem/features/cto/daily-cto-report.md`) asserting *"the RPC now caps severity at
'Medium'/P3"* — that assertion was wrong; the RPC change was apparently never made, or was reverted
outside a migration (same drift pattern as doc 17/18).

This was compounded by the edge function's own "Today" action-plan bucket:
`issues.filter(i => i.eta === 'Today' || i.severity === 'Critical')`. Every other issue type
already sets `eta: 'Today'` precisely when it means same-day, *including* when severity is
Critical — the slow-query block is the one type that deliberately never does
(`eta: 'Ongoing - chronic performance debt, not a same-day incident'`). The `|| severity ===
'Critical'` clause silently overrode that, so the report's "CTO Engineering Action Plan: Today"
section listed four chronic queries as same-day P1s one column away from text saying they weren't.

**Fix:** RPC now caps slow-query severity at Medium/Low and emits explicit `priority` (`P3`),
`blocking_production` (`false`), and `resolution_eta` fields directly, so the edge function reads
the RPC's classification instead of re-deriving urgency. The "Today" bucket now reads
`eta === 'Today'` only.

### 3. Board memo's "Financial controls automated" contradicted its own headline

The memo's headline correctly says *"No financial-control automation is currently failing; all
scheduled control jobs completed in the last 24 hours"* — that logic filters failing jobs through
`GUARDRAIL_RE` (money-related keywords). But the scorecard row directly below it,
**"Financial controls automated: 164 of 165 — Below target,"** used a different, unfiltered
calculation: `total_scheduled - failingJobs.length`, where `failingJobs` includes ad-hoc/unscheduled
invocations (e.g. `(unscheduled) email_queue_dispatch`, triggered via
`cron.schedule_in_background`, not a fixed `cron.job` entry) that were never part of the
165-scheduled-job count in the first place.

Verified against production for 2026-09-15: all 7 failures that day came from `job_run_details`
rows with `jobid` values that don't exist in `cron.job` (i.e. `(unscheduled)`) — 0 of the 165
actually-scheduled cron jobs failed.

**Fix:** the indicator now excludes `failingJobs` entries where `j.unscheduled === true` before
computing the "N of 165" figure.

### 4. Commits / Rolled-back transactions showed a fabricated "0"

Section 3 (Infrastructure Operations) rendered `fmt(I.commits)` / `fmt(I.rollbacks)` directly.
`get_cto_daily_report()` already correctly returns `NULL` for both when there's no trustworthy
day-over-day `db_stat_snapshots` pair — but `fmt` is `Number(v || 0).toLocaleString(...)`, so
`fmt(null)` silently renders `"0"`. The true state ("Unavailable") was already correctly shown
three sections later, in Infrastructure Alerts, for the exact same underlying gap — the two
sections of the same PDF disagreed with each other.

**Root cause of the gap itself:** `db_stat_snapshots` had no new row since 2026-09-02 (14 days
stale as of the 2026-09-15 report). The `capture-daily-cto-snapshot` cron job that was supposed to
prevent exactly this — written in migration `20260912093000_schedule_daily_cto_snapshot_capture.sql`
— **did not exist in production.** The migration file was in the repo; it had simply never applied
live. This is the same "trust the live catalog, not the migration history" trap documented
throughout this folder.

**Fix:** both KPI-card renderers now gate on `I.rollback_trustworthy === true`, showing
`"Unavailable"` otherwise. Re-applied `capture-daily-cto-snapshot` directly against production
(now `jobid 39041`, `55 20 * * *` = 23:55 EAT) rather than relying on a future migration push to
take effect.

---

## What was checked and found correct — no change made

- Board memo's "Sign-in sessions that eventually succeeded" (671 of 758, 88.5%) — independently
  recomputed with a `session_trace_id`-keyed query against live data and matched exactly. The
  2026-08-29 accuracy-gate doc (`docs/investigations/Board_Memo_Preview_Generation_Prompt.md`,
  Gate C) checks for this fix via a `prosrc LIKE '%signin_sessions_tried_7d%'` string match, which
  now returns false — but that's a stale variable-name check, not evidence of a regression; the
  underlying logic (`sessions_tried`/`sessions_succeeded` CTEs keyed on `session_trace_id`) is
  present and correct under a different name.
- SMS "confirmed on the handset: Not being recorded" — verified live
  (`sms_delivery_log`: 0 ever `status='delivered'` against 22,862 rows with a provider message ID
  in the last 30 days). Correctly rendered as a measurement fault, not a fabricated `0.0%`.
- Financial ledger postings, RLS coverage (688/688), backup status, and the agent/tenant/funder
  "who the platform serves" segment counts were not disputed by this pass.

---

## Verify this is still working

```sql
-- Confirm both RPC fixes are live (not just in the repo):
SELECT
  (SELECT prosrc LIKE '%status NOT IN (''success'',''ok'')%' FROM pg_proc p
     JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='get_cto_diagnostics') AS diag_fix,
  (SELECT prosrc LIKE '%q.mean_exec_time > 500 THEN ''Medium''%' FROM pg_proc p
     JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='get_cto_issue_intelligence') AS intel_fix;
-- expect both true

-- Confirm the snapshot-capture cron actually exists (not just in a migration file):
SELECT jobid, jobname, schedule, active FROM cron.job
WHERE jobname = 'capture-daily-cto-snapshot';
-- expect one active row, schedule '55 20 * * *'

-- Confirm db_stat_snapshots is catching up (should have no gap wider than 1 day
-- once the job has run at least twice from 2026-09-16 onward):
SELECT day, captured_at FROM public.db_stat_snapshots ORDER BY day DESC LIMIT 5;
```

If `intel_fix`/`diag_fix` ever flips back to `false` with no corresponding migration in
`supabase/migrations/`, suspect a silent direct-against-prod revert — see
[`17-critical-function-drift-detection.md`](./17-critical-function-drift-detection.md).

---

## What not to do

- Don't trust a code comment that says an RPC "now" does something without querying
  `pg_proc.prosrc` (or re-reading `pg_get_functiondef`) against production to confirm it. This is
  the second time in this file's history (see doc 18, doc 17) that a fix believed to be live
  wasn't. `supabase/migrations/` reflects intent, not deployed state.
- Don't add a `|| severity === 'Critical'` (or similar coarse) fallback to a bucket/threshold that
  another code path already sets deliberately and more precisely (`eta`, here). The fallback will
  eventually re-introduce exactly the contradiction it was presumably meant to catch.
- Don't compute a "financial controls" or similarly-scoped metric from an unfiltered job list
  (`J.total_scheduled`, `failingJobs`) without checking whether every entry in that list actually
  belongs to the population the metric's label promises.
