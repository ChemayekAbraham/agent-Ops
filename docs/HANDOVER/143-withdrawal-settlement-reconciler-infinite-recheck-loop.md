# 143 — Withdrawal settlement reconciler re-checked the same 3,512 rows forever

**Date:** 2026-09-28
**Status:** FIXED and applied to production 2026-09-28 10:19 UTC. Verified on the next run.
**Migration:** `supabase/migrations/20260928100000_reconcile_withdrawal_settlements_backoff.sql`
**Follows:** doc 142 (CTO report triage). This is the main write-load source behind that report's rollback and slow-query items.

## What was wrong

`reconcile_evidenced_withdrawal_settlements()` (cron `*/10`) rewrote **exactly 150 `withdrawal_requests` rows every run**. That's about 21,600 row updates a day, and 235k since 09-17 on a table of 11,951 rows.

- **3,512 rows were stuck in the loop**, re-checked 748 times each on average (max 1,309).
- 3,508 of them are `completed` withdrawals whose only missing ledger leg is `merchant_telecom_charge`. That's the pre-`3f179b8c0` telecom-fee split, and see the memory note on off-system settlement: these are **not** owed money. The other 4 are `paid` withdrawals missing `customer_wallet_debit`. They are **not investigated here** and need a Finance look.
- None of them has payment evidence, so none can ever become `settled`.

**Why they never aged out.** The candidate query windowed and ordered by `w.updated_at > now() - 30 days`, and `record_withdrawal_settlement_state()` sets `updated_at = now()` on every check. Each check re-qualified the row for the next one.

**Consequences**
- Every re-check is an UPDATE on a table published to Supabase Realtime, and several screens listen to it without a filter. This is the most likely driver of the rollback spikes in doc 142.
- The function averaged 18 s per run and about 27,800 s of DB time since 09-17.
- **A newly evidenced withdrawal waited up to ~4 h to be finalized to `paid`.** The queue was a round-robin over about 3.5k rows, oldest `updated_at` first, and a new row sorts last.
- The `withdrawal.settlement_incomplete_alert` branch has never fired (0 events ever). That's because the looping rows have no evidence, and `coalesce(evidence_at, now())` is never 20 minutes old.

## Fix

The fix changes only the selection. The per-row logic and the finalize-to-`paid` branch are unchanged.
- The window uses `greatest(created_at, evidence created_at)`, not `updated_at`.
- **Backoff:** a row is re-checked every run for its first 6 attempts (about 1 h), then at most once per 24 h.
- Order is `settlement_checked_at NULLS FIRST, created_at DESC`, so never-checked and newest rows go first.
- `record_withdrawal_settlement_state()` is **not** changed, because `approve-withdrawal` also calls it. It still bumps `updated_at` on each check. That is now bounded by the backoff, but it's still a no-op write worth removing later.

Not in `critical_function_baselines`, so no re-baseline was needed.

## Verification

- Dry run before applying: 1,457 rows in the new window, 0 due immediately. Steady state is about ≤1.5k re-checks a day instead of about 21.6k.
- Live function body confirmed (`settlement_checked_at NULLS FIRST` present).
- Cron runs on the job: 09:50, 10:00 and 10:10 each touched 150 rows in 25–41 s. **10:20, the first run on the new logic, touched 10 rows in 3.5 s.**

**To check it held:** take the daily rollback rate from `db_stat_snapshots` for a full weekday week. The target is under 5% with no spike days. If the spikes continue, Realtime is not the whole story (see doc 142).

**Revert:** re-apply the previous body from `pg_get_functiondef` history in this doc's commit diff. The old selection was `WHERE (...) AND w.status NOT IN (...) AND w.updated_at > now() - interval '30 days' ORDER BY w.updated_at LIMIT 150`.

## Not done yet (see the brief to Gemini, 2026-09-28)

- Remove the 6 tables with no listeners from the `supabase_realtime` publication. **Blocked** by the tool permission check as a shared-resource change and left for Josh to approve.
- Publish `deposit_requests`, but only after the unfiltered backoffice listeners on it move to polling.
- Frontend data-code changes: dead listeners replaced by polling per Gemini's decisions, and the kill-switch hooks made to poll.
