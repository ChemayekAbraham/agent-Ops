# 66. Triage — 2026-09-18 Daily CTO Report: one real fix live, two migrations blocked, one report metric debunked

**Mixed status: `email_queue_dispatch` fixed and verified live; two migrations written but
blocked from direct production application by the auto-mode classifier (needs manual apply); one
headline report figure verified misleading, fix written but also blocked.**

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

## 3. "Sign-in effectively broken" — real number, misleading statistic

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

**Not applied to production** — same "Production Deploy" classifier block as #2. Migration file
(`20260918020000_add_signin_latency_median_context.sql`) and the edge function edit are both
committed; the RPC change needs manual apply before the edge function change has any effect (the
edge function already reads the new fields, which will come back `null` via `COALESCE`-free `fmt()`
→ render as `0`/blank until the RPC ships — verify both landed together, not just the function
deploy).

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

## 5. Found, not fixed — needs your call

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

-- sign-in latency: confirm the new fields are populated (once RPC migration lands)
select (get_cto_daily_report()->'auth'->>'median_login_ms_today')::numeric,
       (get_cto_daily_report()->'auth'->>'avg_login_ms_today')::numeric;
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
