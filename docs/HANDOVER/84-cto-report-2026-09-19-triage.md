# 84. Triage — 2026-09-19 Daily CTO Report: fourth `email_queue_dispatch` regression, rollback spike confirmed real but unattributed

**Mixed status: `email_queue_dispatch` diagnosed and fix written, blocked from direct production
application; the report's #1 same-day item (transaction rollback rate) verified as a genuine,
non-artifact spike, but its proposed root cause (wallet cache/drift cron jobs) is disproven by the
data — actual cause needs Postgres log inspection outside this tool's reach.**

Each claim was verified against live production before acting on it, per this folder's standing
rule (doc 06).

---

## 1. `email_queue_dispatch()` — fourth self-cancel regression, this time it actually landed

Docs 18 and 66 §1 documented three prior occurrences of this bug (2026-09-13, -14, -18): the
empty-queue branch calls `cron.unschedule('process-email-queue')` from inside its own execution,
which pg_cron logs as `"job canceled"`. Doc 66's fix was confirmed live and re-baselined at
**2026-09-18 06:26:57 UTC** — `critical_function_drift_alerts` shows a *new* alert opened 19
minutes later (06:45:00 UTC) and it sat open and unresolved through today's report, exactly
repeating the pattern doc 66 itself warned about.

Verified live 2026-09-19: `pg_get_functiondef` shows the function body has reverted to the same
advisory-lock-guarded disarm variant as the third regression — no migration file in the repo
recorded the change. This time it actually **completed**: `select * from cron.job where jobname =
'process-email-queue'` returns zero rows. The dispatcher is not running on any schedule right now.

**Still cosmetic, not a delivery failure** — confirmed both `pgmq.q_auth_emails` and
`pgmq.q_transactional_emails` are empty, and `email_queue_wake()` (unchanged, still correct)
re-arms the cron job *and* fires `process-email-queue` directly on every enqueue trigger, so no
email is currently stuck. But with zero background polling, an email that fails
`email_queue_wake`'s inline dispatch (e.g. a transient `net.http_post` error) has no fallback until
the next enqueue.

**Fix written, not applied** — migration
`20260919060000_refix_email_queue_dispatch_self_cancel_regression_v4.sql` reapplies doc 18's Fix #1
(never self-disarm), re-arms the job directly (`cron.schedule`, since simply waiting for the next
enqueue leaves a gap), and re-baselines in the same file. Both the `CREATE OR REPLACE FUNCTION` and
the `cron.schedule` call were blocked when attempted directly against production ("Modify Shared
Resources" — the auto-mode classifier's flag for cron/function-body writes, same class of block as
docs 62/63/72/73/74/75 in this folder). **Needs Josh to run the migration by hand.**

Do not re-baseline `critical_function_baselines` or resolve the open drift alert until the
`CREATE OR REPLACE FUNCTION` half has actually landed — the migration does both in the right order,
but if it's ever split up, re-baselining against the still-broken live body would make the detector
blind to its own target.

## 2. Transaction rollback rate — real and severe, not the lifetime-ratio artifact this folder has seen three times before, but the report's own causal link doesn't hold

This is the report's only same-day item and its highest revenue-risk rating. This folder has
flagged the "mean/count on a lifetime-cumulative pg_stat_database counter reads as a false
same-day P1" pattern three times already (docs 20, 29, 66 §3) — so the first move was to check
whether `rollback_trustworthy` actually holds for today rather than assume the number is fabricated
again.

It does. `db_stat_snapshots` has consecutive daily rows for 2026-09-17 → -18 → -19 (the gate that
gave "Unavailable" for years of gapped history, e.g. an 08-15→08-29→09-02 stretch with two-week
holes, and correctly rejected 09-16→09-17 when the underlying counters were reset by a restart
mid-window). Day-over-day deltas from `db_stat_snapshots`:

| Day | Commits | Rollbacks | Rollback rate |
|---|---|---|---|
| 2026-09-18 | 1,737,588 | 108,197 | 5.9% |
| 2026-09-19 (today) | 423,365 | 402,744 | **48.75%** |

Confirmed via `get_cto_daily_report()->'infra'`: `rollback_trustworthy: true`,
`rollback_baseline_at: 2026-09-18T20:55Z` (a clean, non-gapped baseline). Nearly half of all
transactions on the DB today ended in rollback — this is real, not a stats artifact.

**The report's own hypothesis — wallet cache/drift cron jobs, because five of them share the slow-
statement list with this item — is disproven by the data.** Checked all four candidates directly:

| Job | Schedule | Runs in 24h | Failed |
|---|---|---|---|
| `refresh-wallet-totals-cache` | every 3 min | 480 | **0** |
| `repair-wallet-cache-drift-15m` | every 15 min | 96 | **0** |
| `wallet-projection-drift` | every 15 min | 96 | **0** |
| `reconcile-evidenced-withdrawal-settlements` | every 10 min | 144 | **0** |

Zero failures across all four, and even a 100% failure rate on all of them combined (816 runs/day)
couldn't explain a 402,744-transaction spike. Also ruled out sign-in load: only 187
`auth.signin.attempt` events in the last 24h, three orders of magnitude too small.

**Root cause not found — needs Postgres log access this tool doesn't have.** `pg_stat_statements`
only records statements that complete; a statement that errors out (the thing that would actually
*cause* a rollback — a constraint violation, a `RAISE EXCEPTION` in a hot RPC, a serialization
failure) is largely invisible to it by construction, so its top-by-calls list can't point at the
failing query. `pg_stat_activity` right now shows no idle-in-transaction-aborted sessions, so
whatever drove the spike isn't actively happening at the moment this was checked. `pg_stat_database`
shows 0 deadlocks today, ruling that out specifically.

**Next step for whoever picks this up:** pull the actual Postgres error log from the Supabase
dashboard (Logs → Postgres Logs, or the Log Explorer) for the last 24h and filter for `ERROR`/
`FATAL` — that will show the actual failing statement class, which this SQL-only investigation
cannot surface. Given the scale (400K+), it is very likely one specific hot path (a single RPC or
trigger called on nearly every write) rather than a diffuse mix.

## 3. Not investigated this pass

Items 2 (auth failure rate / bot traffic), 4 (slow wallet/reconciliation statements beyond the
rollback-link disproof above), and 5 (API failures on unattributed client request) were not
triaged in this session — flagging so the next pass doesn't assume they were checked.

---

## Verify this is still working

```sql
-- email_queue_dispatch: confirm no self-cancel and the job is scheduled again
select pg_get_functiondef(oid) like '%cron.unschedule%' as still_broken
from pg_proc where proname = 'email_queue_dispatch'; -- expect false
select jobid from cron.job where jobname = 'process-email-queue'; -- expect one row
select resolved_at from critical_function_drift_alerts
where function_signature = 'email_queue_dispatch()' order by detected_at desc limit 1; -- expect not null, AFTER the CREATE OR REPLACE landed

-- rollback rate: is today's spike continuing or was it a one-off?
select day, xact_commit, xact_rollback,
  xact_commit - lag(xact_commit) over (order by day) as day_commits,
  xact_rollback - lag(xact_rollback) over (order by day) as day_rollbacks
from public.db_stat_snapshots order by day desc limit 5;
```

## What not to do

- Don't re-baseline `email_queue_dispatch` in `critical_function_baselines` before confirming
  `pg_get_functiondef` no longer contains `cron.unschedule` — migration
  `20260919060000` does both in the correct order; don't split them.
- Don't assume the wallet cache/drift cron jobs are the rollback source just because the report
  lists them in the same slow-statement bucket — zero failures across all four in the same 24h
  window the rollback spike covers.
- Don't try to root-cause the rollback spike further from `pg_stat_statements` or
  `pg_stat_user_functions` alone — `track_functions` is off (empty `pg_stat_user_functions`) and
  statements that error don't reliably show up in `pg_stat_statements`'s top-calls list. This needs
  the Postgres error log, which isn't reachable from this SQL-only tool.
