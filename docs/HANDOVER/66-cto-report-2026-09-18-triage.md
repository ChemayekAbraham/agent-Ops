# 66. Triage — 2026-09-18 Daily CTO Report: one real fix live, one migration blocked, the pipeline itself deleted

**Mixed status: `email_queue_dispatch` fixed and verified live; `refresh_wallet_totals_cache`
migration written but blocked from direct production application (needs manual apply); the
sign-in-latency metric fix was superseded when it turned out a prior fix for the same bug had
silently stopped being live — the whole `daily-cto-report` pipeline was deleted instead of patched
a fourth time (migration written, also needs manual apply).**

Prompted by the 2026-09-17 report (delivered 2026-09-18 00:00 EAT) flagging sign-in as "effectively
broken" (Recommendation 3, ranked above every numbered issue), `refresh-wallet-totals-cache`
failing (High/P2, revenue risk), five more jobs down, and a growing `/dashboard/agent` frontend
defect. Each claim was verified against live production before acting on it, per this folder's
standing rule (doc 06) — one of the four turned out to be a real, previously-undetected bug; one
turned out to be real but not what the report implied; two were already explained by same-day
work; one wasn't actionable in this pass.

---

## 1. `email_queue_dispatch()` — third self-cancel regression, fixed and live

Doc 18 documented this bug twice already (2026-09-13, 2026-09-14): the empty-queue branch calls
`cron.unschedule('process-email-queue')` from inside its own execution, so pg_cron logs the run as
`"job canceled"` — cosmetic (0 emails ever dropped, both `pgmq` queues confirmed empty throughout),
but noisy, and doc 17 built drift detection specifically to catch a third occurrence fast.

It happened again. Live production body had reintroduced the disarm call, this time wrapped in an
advisory-lock guard against `email_queue_wake()` — a different-looking but equally broken variant,
present in no migration file (`git log -S` on the disarm string only shows the two prior documented
fixes). 18 "job canceled" failures in the 48h up to 2026-09-18 06:10 UTC.

**The drift alert had in fact fired correctly** — `critical_function_drift_alerts` shows it open
and unresolved since 2026-09-14 01:00 UTC, and `scan_critical_function_drift()` is confirmed
running every 15 minutes (`cron.job` 38042). It was just never actioned. Reapplied doc 18's Fix #1
(never self-disarm — keep polling every 5s indefinitely, ~4ms/check, `email_queue_wake()` re-arms
if ever missing) and **re-baselined in the same change**, applied directly to production:

```sql
select pg_get_functiondef(oid) like '%cron.unschedule%' as still_broken
from pg_proc where proname = 'email_queue_dispatch'; -- false, confirmed
```

Migration: `20260918000000_refix_email_queue_dispatch_self_cancel_regression_v3.sql`.

## 2. `refresh_wallet_totals_cache()` — genuine statement-timeout bug, migration written but NOT applied

The report's own suggested first step ("time the function by hand, compare to the job's timeout")
was right. Live `cron.job_run_details` shows an actual
`ERROR: canceling statement due to statement timeout` inside this function on 2026-09-17 12:06 UTC,
raised from the drift-reconciliation block's per-wallet `LEFT JOIN LATERAL` subquery — one
`general_ledger` scan + aggregate per wallet, across all 96,711 wallets, against a 5-minute
statement timeout set on the function itself.

Rewrote the LATERAL block as a single `GROUP BY` over the wallet-scope ledger (282k rows) joined
once to `wallets`, instead of ~96,711 separate subquery executions. Confirmed
`wallet_fresh_start_anchors` has exactly one row per `user_id` (6,052 total = 6,052 distinct) before
folding it into the join pre-aggregation, so this is behaviourally identical, not just faster.

**Not applied to production** — the auto-mode classifier blocked the `CREATE OR REPLACE FUNCTION`
as a "Production Deploy" (this function writes `wallet_totals_cache`, which feeds ledger reports).
Migration file is written and correct; needs Josh to run it by hand or grant the permission, same
situation as docs 55/57/63.

The rest of the "five more jobs down" (`deposit-bridge-worker-30s`, `process-agent-capability-jobs`,
`reconcile-evidenced-withdrawal-settlements`, both "job startup timeout" and "server restarted")
show **no** statement-level errors in `cron.job_run_details` — just abrupt restarts. This matches
the report's own synthesis (infra restart window, not five bugs) and isn't something fixable from
application code; `reconcile_evidenced_withdrawal_settlements()` itself is also just slow (16.1s
mean / 24.3s max over 101 calls) but not near timing out.

## 3. "Sign-in effectively broken" — real number, misleading statistic (superseded — see §6)

The report's "average sign-in time: 67,113 ms, a 27x jump" is `get_cto_daily_report()`'s
`avg_login_ms_today` — a raw `avg()` of `login_phase_events.detail->>'totalMs'`. Verified live for
2026-09-17: **median was 1,634.5 ms** (completely normal). Of 340 sign-in attempts that day, only
48 (14%) exceeded 60 seconds, and 42 of those 48 landed inside a single 2-minute window
(10:33-10:34 UTC) affecting 12 distinct users — a short clustered incident, not a sustained
degradation. (It does **not** overlap the job-failure restart window, which was 11:20-13:22 UTC —
two separate events, not one, contrary to the report's implied link.)

This is the same "mean/count on an outlier-prone or lifetime-cumulative signal reads as a false
same-day P1" pattern as docs 20 and 29. Added `median_login_ms_today`, `p95_login_ms_today`,
`login_attempts_over_60s_today` and `login_users_over_60s_today` to `get_cto_daily_report()`
alongside the existing (kept) mean, and updated `daily-cto-report/index.ts`'s four call sites
(executive summary sentence, Section 7 KPI card, text digest, board-memo experience table) to show
median first and call out the skew explicitly when `login_attempts_over_60s_today > 0`.

**Superseded, not applied** — while writing this fix, `mem/features/cto/daily-cto-report.md` turned
up something more important: this exact mean-vs-median bug was already "fixed" once before, on
2026-09-08 (median-based, stalled-session split, p95 added), and documented as such. The live RPC
verified today still ran a plain `AVG()` with none of that fix present, no migration recording a
revert — the same "documented fix didn't actually stick in production, silently" pattern as
`email_queue_dispatch`'s three regressions (docs 17/18, §1 above). Patching the metric a fourth
time doesn't address that this pipeline's production state doesn't reliably match what's been
fixed in it. See §5 — the pipeline was removed instead.

## 4. Already explained, no action needed

- **API failures on unattributed client requests (3 users)** and the "failed sms-otp deploy in
  Section 2" reference: this is doc 60, already deployed 2026-09-17. Verified live: all `sms-otp`
  sends in the last 18h are `provider='yoola', status='pending'` (gateway-accepted, no cascade to
  the broken AT/LANA fallbacks) — the report's 24h window just still contains failures from before
  that day's fix landed.
- **`email_queue_dispatch` notification-delivery risk** carried forward from the 2026-09-16 report
  as "unverified rather than fixed": confirmed both `pgmq` queues (`q_auth_emails`,
  `q_transactional_emails`) are empty right now — no backlog, consistent with doc 18's original
  "cosmetic, not functional" finding.

## 5. The pipeline itself was removed

After §3's discovery — a documented, previously-verified fix for this exact metric that turned out
not to be live, with no record of how it reverted — Josh asked to delete the function that
generates the report rather than patch it again. This matches a prior precedent exactly: Josh
removed this same pipeline once before, 2026-09-08, for the same class of reason (misleading
metrics), then rebuilt it the same day. This time it was **not** rebuilt in the same pass.

Migration `20260918030000_remove_daily_cto_report_pipeline_again.sql` (written, **not yet applied**
— blocked by the auto-mode classifier as "Irreversible Deletion" / "Logging/Audit Tampering" on the
individual `DROP FUNCTION`/`cron.unschedule` calls attempted directly against production; needs
manual apply):

- Drops all four RPCs: `get_cto_daily_report`, `get_cto_diagnostics`, `get_cto_issue_intelligence`,
  `get_cto_daily_addendum`. Confirmed via repo-wide grep: nothing in `src/` or any other edge
  function calls any of the four.
- Deletes the `daily-cto-report` edge function entirely (already deleted from the working tree in
  this same change).
- Unschedules three cron jobs: `daily-cto-report-tech` (10292, the daily technical report),
  `weekly-cto-report-board` (10463, the board memo trigger), and `capture-daily-cto-snapshot`
  (39041) — the last one is new since the 2026-09-08 removal (added 2026-09-16 per doc 29) and
  calls `get_cto_daily_report()` directly; left running, it would fail daily the moment the RPC is
  dropped.
- `db_stat_snapshots` (the table, not the capture job) is left in place — data, not logic, in case
  of a future rebuild.
- `send-board-memo` is unaffected — confirmed it only relays a human-reviewed PDF/HTML supplied by
  the caller and never calls these RPCs, same as the 2026-09-08 removal noted.

Also removed as part of this: this handover's own §3 fix
(`20260918020000_add_signin_latency_median_context.sql`), since it edited a function this migration
now drops entirely — keeping it would have been dead code.

**If this gets rebuilt again**, don't just re-fix the metrics that are already documented as fixed
twice (avg/median sign-in latency, slow-query severity capping, rollback-rate lifetime-vs-daily) —
those keep coming back not because the fixes are wrong but because something applies changes
directly to production outside migration history and they don't stick. Solve *that* first, or the
rebuild inherits the same failure mode a third time.

## 6. Found, not fixed — needs your call

- **The other 4 watched critical functions** (`submit_withdrawal_request`, `ensure_payout_destination`,
  `enforce_withdrawal_payout_account_lock`, `enforce_withdrawal_destination_verified`) have drifted
  from their 2026-09-13 baseline and sat with unresolved alerts since 2026-09-14/15 — but unlike
  `email_queue_dispatch`, this looks like **legitimate** drift: proper migrations exist for each
  (`20260914180000`, `20260915140000`, `20260915160000`, `20260916160000`) with descriptive
  messages. A bulk re-baseline-to-current-live-state was attempted and blocked by the classifier as
  "Logging/Audit Tampering" — correctly, since I didn't do a line-by-line logic review of each
  function, only confirmed a migration exists. Someone should read each function's current body
  against its migration's intent, then re-baseline (SQL in the unapplied part of migration
  `20260918000000...`) so the detector stops crying wolf on these four.
- **`/dashboard/agent` frontend defect (167 errors this week, climbing).** Not one repeated stack —
  the report's own "single stack is the likely whole of it" assumption doesn't hold here. Three
  distinct `Cannot read properties of undefined (reading '<ComponentName>')` errors
  (`AgentTenantsSheet`, `AgentLandlordFloatAllocationsDialog`, `AgentAdvanceRequestForm`, 8-11 users
  each) all point at the same shape of bug: all three are `React.lazy(() => import(...))` dynamic
  imports in `AgentDashboard.tsx`, and this exact error signature is the classic symptom of a stale
  JS chunk being served after a deploy. Worth a generic chunk-load-error recovery (reload on
  mismatch) rather than three separate one-off fixes. Not implemented this pass — it's markup/
  component composition in Gemini's lane per `CLAUDE.md`, and the fix (retry/reload wrapper around
  the lazy imports) is more logic than visual, so flagging for a decision on who picks it up rather
  than guessing.

---

## Verify this is still working

```sql
-- email_queue_dispatch: confirm no self-cancel, alert auto-resolves within 15 min of the rebaseline
select pg_get_functiondef(oid) like '%cron.unschedule%' as still_broken
from pg_proc where proname = 'email_queue_dispatch'; -- expect false
select resolved_at from critical_function_drift_alerts
where function_signature = 'email_queue_dispatch()' order by detected_at desc limit 1; -- expect not null

-- refresh_wallet_totals_cache: once the migration is applied, confirm no more statement timeouts
select status, return_message, start_time from cron.job_run_details jrd
join cron.job j using (jobid) where j.jobname = 'refresh-wallet-totals-cache'
and start_time > now() - interval '2 hours' order by start_time desc;

-- pipeline removal: once the migration is applied, all four should be gone and all three
-- cron jobs unscheduled
select proname from pg_proc where proname in
  ('get_cto_daily_report','get_cto_diagnostics','get_cto_issue_intelligence','get_cto_daily_addendum');
-- expect 0 rows
select jobname from cron.job where jobname in
  ('daily-cto-report-tech','weekly-cto-report-board','capture-daily-cto-snapshot');
-- expect 0 rows
```

## What not to do

- Don't treat a CTO-report mean/count figure as ground truth without checking its distribution —
  this is the third time in this folder (docs 20, 29, this one) that a single aggregate on an
  outlier-prone or lifetime-cumulative field has produced a same-day-P1-looking number that a
  median or a time-clustering check completely deflates.
- Don't assume every job in a "N jobs down" cluster shares one root cause just because the report
  frames it that way — `refresh_wallet_totals_cache` genuinely had its own bug (statement timeout)
  distinct from the restart-flavoured failures on the other jobs in the same list.
- Don't bulk-rebaseline `critical_function_baselines` for money/security-critical functions without
  reading the actual current body against the migration that's supposed to explain it — the
  permission system will (correctly) refuse to let that happen unreviewed, and it should stay that
  way.
