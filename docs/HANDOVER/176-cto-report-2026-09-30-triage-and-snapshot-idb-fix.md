# 176 — CTO report 2026-09-30 triage + snapshot IndexedDB fix

## What changed
`src/hooks/useUserSnapshot.ts` cached its IndexedDB handle in a module variable and never cleared it. When the browser closed the connection (iOS backgrounding, storage eviction, a version upgrade in another tab), every later read/write reused the dead handle and threw `InvalidStateError: connection is closing`. The report's 83 errors from one tab on `/dashboard/agent` fit that pattern.

Fix: `onclose` / `onversionchange` now clear the cached handle, and reads and writes go through `withSnapshotDb`, which reopens once and retries on `InvalidStateError`. This is the same pattern already used in `offlineStorage.ts`, `offlineDataStorage.ts`, `offlineCollectionDrafts.ts` and `fieldCollectStore.ts`. Not yet deployed.

## Other report items, checked against live data on 2026-10-01
- **Rollback rate 37.38%:** the database restarted at 05:35 UTC on 10-01, so the since-boot figure is gone. After the restart the rate is 1,144 / 64,167 = 1.8%. A 16-second delta between two snapshots showed 20 rollbacks in 620 transactions (3.2%), which is too small a sample to conclude anything. Earlier triage (docs 142, 151) traced rollbacks to Realtime. Not re-verified today.
- **`tops-refresh-work-items-hourly` "not authorized":** already fixed. `tops_refresh_work_items` calls `tops_plan_position_internal`, and the job succeeded every hour through 06:00 UTC. The wrapper `tops_plan_position` still checks `auth.uid()` roles, which is correct for interactive callers.
- **Notification failures:** not caused by the phone gate. Over the last 24h in `sms_delivery_log`: 78 Yoola HTTP 429 rate-limit failures, about 32 invalid-number failures, 1 phone-gate block. Same cause as the 09-29 board report: provider rate limit, not the queue.
- **Auth 70.8%:** not touched. The three-IP credential-stuffing claim and the `auth.enforceAccountAccess.end` p95 are unverified.
- **Slow statements (`refresh_wallet_totals_cache`):** not touched. EXPLAIN ANALYZE is still outstanding.

## Architecture map
No update: client-side cache robustness only, no new subsystem or flow.
