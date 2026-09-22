# 101 — 2026-09-22: `email_queue_dispatch` sixth regression fixed; rollback-rate spike is NOT resolved, it's active and worse than reported

Triage of the CTO report emailed 2026-09-22 (data through 2026-09-21), which repeated two P2 items
doc 88 (2026-09-21) believed were closed or self-resolved. Checked both against live state before
touching anything, per the repo-vs-production gotcha.

## 1. `email_queue_dispatch()` — sixth self-cancel regression, fixed and re-verified

Doc 88 fixed the fifth occurrence and verified it live at 2026-09-21 05:02 UTC. `critical_function_drift_alerts`
shows a new alert opened at **06:30 UTC the same day** — about 90 minutes later — and it sat
unresolved and un-actioned for roughly 24 hours until this session.

Verified live before fixing:
- `pg_get_functiondef('email_queue_dispatch()')` contained the same advisory-lock-guarded
  `cron.unschedule('process-email-queue')` self-cancel body as the third/fourth/fifth regressions.
- `cron.job` had zero rows for `process-email-queue` (fully unscheduled).
- `get_cto_diagnostics('2026-09-21')` showed the function still running 1,461 times in 24h (via
  `email_queue_wake()`'s inline dispatch on every enqueue, not cron — same mitigation doc 88
  documented) with 12 failures, exception `job canceled`, `last_success_at` later than
  `last_failure_at` (self-recovering per-call, not stuck).

Applied the same fix as every prior occurrence directly to production (doc 18 Fix #1: never
self-disarm), re-armed `process-email-queue` on its 5-second schedule (new `jobid 41486`),
re-baselined `critical_function_baselines`, and resolved the open drift alert in the same batch.
Also committed migration `20260922060000_refix_email_queue_dispatch_self_cancel_regression_v5.sql`
to the repo (the live fix, applied and verified first, matches this file).

**Verified live after fix:** `still_broken = false`, `cron.job` has one active row on a 5-second
schedule, drift alert `resolved_at` set.

**Still unexplained, same as every prior occurrence:** how the live body keeps reverting to the
disarm variant with no migration recording it (`git log -S` on the disarm string only shows the
five documented fixes, doc 84). This is the sixth time — if it recurs, check first whether the
committed fix (this migration or a later one) is actually live before writing a seventh.

## 2. Transaction rollback rate — doc 88's "self-resolved by 09-20" does not hold; it's active right now and higher than any day in the CTO report

The CTO report says "3rd consecutive day (19, 20, 21 Sep)" for this item. Recomputed day-over-day
deltas from `db_stat_snapshots` (each row is a cumulative end-of-day snapshot, so the rate is the
diff between consecutive days, not the raw cumulative numbers):

| Day | Commits (delta) | Rollbacks (delta) | Rollback rate |
|---|---|---|---|
| 2026-09-18 | 1,737,588 | 108,197 | 5.9% |
| 2026-09-19 | 1,163,871 | 434,321 | 27.2% |
| 2026-09-20 | 1,245,553 | 55,220 | 4.2% |
| 2026-09-21 | 1,935,645 | 523,178 | **21.3%** |

Doc 88 only had data through 09-20 and concluded the spike was a one-day event that had already
resolved. It hadn't — **09-21 spiked again to 21.3%**, and it is still elevated right now:
comparing the 09-21 20:55 UTC snapshot to live `pg_stat_database` at 2026-09-22 04:45 UTC gives a
**~59.6% rollback rate over the last ~8 hours** (commits +195,905, rollbacks +288,861) — worse than
any full day in the report. This is an active condition, not a resolved one-day artifact.

Checked and ruled out as of 2026-09-22 04:45 UTC:
- **No blocked queries or lock waits.** `pg_stat_activity` shows nothing but the realtime
  replication slot — whatever is rolling back is not stuck in contention right now, each
  transaction fails and exits fast.
- **Not a `general_ledger` volume problem right now.** Only 408 rows inserted into `general_ledger`
  in the last 6 hours — nowhere near enough to explain 288,861 rollbacks. (09-21's ledger posting
  count *was* genuinely 12-14x normal — 23,777 postings vs 1,664–3,793 on adjacent days, matching
  the report's "23,757 from 1,911" claim — but that was mostly `agent_collections`-sourced
  `agent_float_cash_offset`/`rent_receivable_created` legs, i.e. ordinary collection recording
  volume that day, not a retry storm on the ledger table itself. No unique constraint exists on
  `general_ledger.idempotency_key` — only a lookup index — so the report's specific hypothesis
  (idempotency-key unique-violation retry storm) doesn't match the schema as it stands.)
- **No dedicated backend/Postgres exception log exists to query.** `public_error_logs` is
  frontend-only; `get_cto_daily_addendum`'s `db_exceptions` field for 09-21 held one client-side
  TypeError, not a database exception. There is no table capturing raw `RAISE EXCEPTION`/rollback
  causes from the database side.

**Root cause still not found — same limitation doc 88 already hit: needs actual Postgres error-log
inspection (Supabase dashboard → Logs → Postgres Logs, filtered to `ERROR`/`FATAL`), which is
outside this tool's reach.** What's new this pass is confirming the problem is *ongoing* and
*worse*, not a closed one-day incident — this should be treated as a live P1 today, and whoever has
dashboard log access should pull the last few hours of Postgres error logs before anything else.

## What not to do

- Don't reuse doc 88's "confirmed one-day, already resolved" conclusion for the rollback rate —
  it was accurate against the data available at the time (through 09-20) but is now stale and
  wrong. Re-verify against `db_stat_snapshots` + live `pg_stat_database` before repeating it.
- Don't chase the report's idempotency-key-unique-violation theory on `general_ledger` specifically
  — that table has no unique constraint to violate. If a unique-constraint theory is worth
  pursuing, look elsewhere (e.g. `agent_collections.client_ref`, `deposit_requests.transaction_id`).
- Don't re-diagnose `email_queue_dispatch` from scratch if it recurs a seventh time — the fix
  pattern is identical every time (doc 18 Fix #1). Check first whether a *committed* fix actually
  landed live; this folder has now found five gaps between "committed" and "live" for this exact
  function.
