# 142 — CTO report 2026-09-27: triage + field-collect IndexedDB connection leak fix

**Date:** 2026-09-28
**Report:** "Welile Daily Tech Diagnostic Report — 2026-09-27" (Health 89, Errors 32, auth 89.5%)
**Code change:** `src/lib/fieldCollectStore.ts` only. No migration, no DB write, no cron change.

All figures below were measured against production on 2026-09-28 ~05:50 UTC.

## 1. Rollback rate "above threshold" (report's only "resolve today" item) — not a ledger incident

Daily deltas from `public.db_stat_snapshots` (the same source the report uses):

| Snapshot day | Commits | Rollbacks | Rate | general_ledger rows that day |
|---|---|---|---|---|
| 09-27 | 899,153 | 24,807 | **2.68%** | 1,564 |
| 09-26 | 965,576 | 388,564 | 28.69% | 1,745 |
| 09-25 | 1,628,802 | 412,157 | 20.19% | 2,707 |
| 09-24 | 1,830,580 | 729,368 | 28.49% | 3,914 |
| 09-23 | 1,671,908 | 92,869 | 5.26% | 4,182 |
| 09-21 | 1,935,645 | 523,178 | 21.28% | 23,757 |
| 09-20 | 1,245,553 | 55,220 | 4.25% | 1,911 |

- 09-27 was already back to 2.68%. The partial day after that snapshot runs at about 1.9%.
- **Rollbacks don't follow ledger volume.** 09-26 had the fewest postings of the week and the highest rate. 09-21 had the most postings and a lower rate. "A rollback is a ledger write that silently didn't land" doesn't hold up. A failed RPC also returns an error to its caller; it doesn't vanish silently.
- No cron job failed on any spike day (`cron.job_run_details`), so scheduled jobs aren't the source.
- `pg_stat_statements` (reset 09-17 13:23) shows 444k explicit `ROLLBACK`s. 439,705 of them come from `supabase_admin`, which is Supabase's Realtime service; app roles account for about 4.6k. The remaining ~2.7M are implicit: errored statements, which pg_stat_statements doesn't record.
- **53 tables are in the `supabase_realtime` publication** (including `general_ledger`, `wallet_transactions`, `wallet_balances_projection`, `gmail_transactions`, `sms_delivery_log`), with 74 live subscriptions. Realtime's WAL poll has run 1.76M times since 09-17 at 20.7 ms mean. Leading hypothesis: spikes follow Realtime and client activity, not money writes. **Not proven.** Proving it needs the Postgres error log, which we still can't reach.
- Recommended next step (not done here): trim the Realtime publication to the tables the UI actually subscribes to. This touches frontend subscriptions, so coordinate it with the UI side.

## 2. Errors 3 → 32 — one user's browser, not the platform

`client_error_reports` for 27 Sep EAT: **29 of 32** were `Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing` (plus two sibling IndexedDB messages) on `/dashboard/agent`, 18:00–19:59 EAT. Those are errors in the phone's local IndexedDB, not Postgres, and they have nothing to do with the wallet-report or ledger-backup jobs. Stack: `fieldCollectStore-*.js`. Fixed below.

## 3. Auth success 89.5% — mostly wrong passwords and non-existent accounts

`auth.audit_log_entries` has no rows in the last 24h, so it can't be used for this. The report reads `login_phase_events` (`phase='auth.signin.attempt'`). Last 48h: 130 successes and 17 errors. Every error used up all 6–7 password attempts in about 1.5–2 s (not a slow timeout). 6 of the 17 had `accountExists=false`, and the 17:20–17:22 cluster on 09-27 is one person retrying four times. The low percentage comes from a tiny denominator plus user error. No platform fault found.

## 4. `tops-refresh-work-items-hourly` failing — already fixed

Only failure: 2026-09-27 12:00 UTC. Migration `20260927161000_tops_plan_position_internal_for_cron.sql` (commit b2ee003c11) is live: `tops_plan_position_internal` exists, and `tops_refresh_work_items` calls it. It has succeeded 17 runs in a row since 13:00 UTC. No action needed.

## 5. "Wallet cache chain, 90 s mean" — the report attributed the 90 s to the wrong function

The 90,069 ms mean / 90,255 ms max belongs to `recompute_trust_scores_batch(20000)`, not a wallet function. Max ≈ mean is what a time budget looks like, and this is the intentional batch triaged on 09-21.

The real wallet-side load is **`refresh_wallet_totals_cache()` on a `*/3` cron**. It has run 5,130 times at 15.2 s mean since 09-17, about 78,000 s of DB time. Each run reads the whole ledger for every wallet, and its only write is a single-row upsert into `wallet_totals_cache` (headline figures). It can't lose a money write. Moving it to every 15 minutes would cut about 80% of that load. That's a staleness trade-off for the owner of the totals, so it's left for a decision, not changed here. `reconcile_evidenced_withdrawal_settlements()` (every 10 min, 18 s mean, about 27,800 s total) is the next biggest consumer.

## 6. `/dashboard/agent` errors — Leaflet crash stopped; IndexedDB leak fixed

Last 7 days on this route: the Leaflet `_leaflet_pos` crash (42 + 8 hits) was last seen 09-24, when it was fixed. The one still arriving is the `fieldCollectStore` IndexedDB error (39 hits, 4 users, still firing on 09-27), plus its WebKit twin "Attempt to get all index records… without an in-progress transaction" (7 hits, 5 users).

### Root cause and fix

`openDb()` opened a new IndexedDB connection on **every** call and never closed any. The agent dashboard reads this store constantly, so a long session builds up hundreds of dangling connections. When the browser tears them down (storage pressure, a frozen background tab), the next `db.transaction()` throws `InvalidStateError: The database connection is closing`, and nothing handles it.

Fix, in `src/lib/fieldCollectStore.ts` only; the public API is unchanged:
- One shared cached connection. The cache is cleared on `onclose` and `onversionchange` (which also closes the connection so other tabs' upgrades aren't blocked) and when opening fails. `onblocked` now rejects instead of hanging.
- A `withDb()` wrapper retries **once** on a fresh connection, and only for closed-connection errors. Every other error still propagates as before.
- Write transactions that only rejected on `onerror` now also reject on `onabort`, so an aborted write (for example a quota error) no longer leaves the caller hanging.

Verification: a standalone test using `fake-indexeddb` (in the session scratchpad, not added to the repo).
- New code: 1 connection across 24 calls. After force-closing the connection (the production error), reads and writes recover with exactly one reopen. A genuine bad-key error still rejects and doesn't trigger a reconnect.
- Old code, same test: 23 connections for 24 calls, which confirms the leak.
- Caveat: the old code survives the close test only because it never reuses a connection. So the production trigger (the browser force-closing its pile of connections) is inferred from the error text and stack, not reproduced.
- Isolated `tsc --strict` on the file: clean. `npm run guard:all`: all passed.

**Check after deploy:** `client_error_reports` on `/dashboard/agent` with a message like `%IDBDatabase%` or `%in-progress transaction%` should drop to about zero within a few days. Stale cached bundles may keep reporting briefly.
