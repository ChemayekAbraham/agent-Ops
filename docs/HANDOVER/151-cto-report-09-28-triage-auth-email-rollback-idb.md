# 151 — CTO report 2026-09-28 triage (health 81): auth, email job, rollback, 90s, /dashboard/agent

**Date:** 2026-09-29 · **Status:** one client fix committed (IndexedDB callers); everything else triaged, no incident.

All figures below were queried live against production on 2026-09-29.

## 1. Auth success 74.3%: real users, not credential stuffing

Source: `login_phase_events`, `phase = 'auth.signin.attempt'`, 09-28 EAT day. 110 success / 38 error (= 74.3%, matches report).

- 38 failures from **20 distinct IPs, max 4 per IP**, almost all Ugandan mobile ranges (41.210.x MTN, 102.x). That is not probe traffic, so there is nothing to rate-limit.
- Split: **21 `accountExists=false`** (number not registered, i.e. typos or never signed up) and **17 `accountExists=true`, `winnerPhase=null`, attempts=7** (wrong password / the sign-in race from doc 89).
- 9 of the 20 failing IPs signed in successfully within a few hours.
- The rise is volume: active users went 157 → 278, and 09-25 had a similar 32-error day.
- The report's "Security probes" issue #8 is **not** the same number. None of these failures cluster.

Not a P1. The sign-in race (doc 89) is still the only real auth defect. It remains unfixed.

## 2. email_queue_dispatch "job canceled": Lovable re-provisioning, not our function

- Live job `process-email-queue` (jobid 41808) is active, 5 s schedule; `email_queue_dispatch` has **no** `cron.unschedule`; both pgmq queues are empty. Nothing is backed up.
- The 2 failures (09-28 10:16:44 and 10:18:33 UTC) are on jobids **41757 / 41762, which no longer exist**. That is why the report shows "(unscheduled)".
- Root cause: `pg_stat_statements` shows a block run **216 times since 09-17** as `postgres`:
  `DO $$ BEGIN PERFORM cron.unschedule('process-email-queue'); ... END $$` + `CREATE OR REPLACE FUNCTION email_queue_dispatch/email_queue_wake` + `cron.schedule(...)`.
  **This SQL is not in the repo.** It is Lovable's platform-side email-infra provisioning, re-run on deploys. Each run deletes and recreates the job, and if a dispatch is mid-flight it is killed ("job canceled"). The job was recreated 70 times on 09-28 (heavy deploy day), and 2 of those caught a live run.
- This very likely also explains the earlier "silent reverts" of `email_queue_dispatch` (docs 18/84/88). The platform replays its own template body. Today it replays the fixed body, so no revert happened this time.
- No emails are lost: the next job instance drains the queue 5 s later.

**No action needed.** Optional follow-up: have `get_cto_daily_report` ignore `job canceled` rows whose jobid no longer exists in `cron.job` for this command.

## 3. Rollback rate 3.95% (threshold 2%): Realtime, not ledger rejections

- `db_stat_snapshots` deltas: 09-26 28.6%, 09-27 2.7%, **09-28 3.9%** (75.7k rollbacks / 1.84M commits). This is the 3rd day open by label, but the day-3 value is the lowest of the spike.
- `pg_stat_statements` ROLLBACK by role since 09-17: supabase_admin (Realtime) **475,566**; authenticated 2,702; anon 2,018; service_role 316; postgres 84. **99% is Realtime's.** App-originated rollbacks are around 400 a day.
- The rise in ledger postings (1.5k to 5k) cannot drive this. Same conclusion as doc 142.
- Real fix remains the Realtime publication trim (doc 143, awaiting approval). A report-side fix would snapshot non-supabase_admin ROLLBACK counts and alert on those instead.

## 4. The 90 s slow statement is the function's own budget

`recompute_trust_scores_batch` has `v_deadline := clock_timestamp() + interval '90 seconds'`. Every run in the last 3 days lasted 90.0–90.3 s and succeeded. The postgres role has no statement_timeout. **Do not index it** (recommendation #4 would do nothing). See doc 89 for the ~10-day rotation note.

## 5. /dashboard/agent errors: the IDB error persists after doc 142 (fixed here)

Top error this week: `Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing` (56 events). On 09-28 all 21 came from **one agent on iOS Safari**, on bundles built *after* doc 142. The stack shows the doc-142 retry path itself failing: once WebKit loses its IndexedDB backend, even a freshly opened connection is closing, and only a reload recovers. Every event was `source: unhandled-rejection`. Six refresh callers had no `catch`, and `FieldCollectDailyTotals` polls every 4 s.

**Money-adjacent bug found alongside:** `FieldCollectDialog`/`TenantFieldCollectDialog` do `await addEntry(entry); await refresh();` inside one try. If the save succeeded but the re-read failed, the agent got **"Failed to save"** for a saved collection. Re-entering creates a new client UUID, which means a duplicate field collection.

Fix (client only, no DB change):
- `src/lib/fieldCollectStore.ts`: if the retry connection is also closing, throw `Offline storage stopped responding. Reload the page and try again.` instead of the raw DOM error.
- `FieldCollectDialog.refreshEntries`, `TenantFieldCollectDialog.refresh`, `FieldCollectDailyTotals.refresh` + `refreshTodayTotals`, `FieldCollectDailyDetailsSheet.refresh`, `FieldCollectReconciliationSheet.refresh`, and the auto-sync `getQueuedEntries().then()`: catch and `console.warn`, keeping last-known state. Write paths (`addEntry`) still surface errors.

**Verify after deploy:** `%IDBDatabase%` rows in `client_error_reports` should stop appearing as `unhandled-rejection`.

The #2 cluster (`_leaflet_pos`, 50 events) stopped 09-24 (Leaflet unmount fix). The lazy-chunk `Cannot read properties of undefined (reading 'Agent…')` cluster (~20) is stale-bundle-after-deploy and belongs to Gemini (JSX lazy imports).

## Side note

`tops-refresh-work-items-hourly` failed once, on its first run (09-27 12:00, "not authorized" from `tops_plan_position`), and has succeeded 44 times since. Nothing to do.
