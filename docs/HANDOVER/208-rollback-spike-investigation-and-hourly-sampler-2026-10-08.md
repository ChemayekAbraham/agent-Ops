# 208 — Rollback spike investigation + hourly sampler (2026-10-08)

**BUILT 2026-10-08, migration `20261008110000` not applied. Cause NOT established.**

## What the data shows (daily deltas, `db_stat_snapshots`)
Quiet days sit at about 2.4% rollbacks (09-27 2.7, 09-29 2.1, 10-02 2.4, 10-03 2.4, 10-04 2.5). Spike days: 09-24 28.5, 09-25 20.2, 09-26 28.7, 09-30 37.4, 10-05 36.2, 10-06 17.5, 10-07 18.1 (0.4-1.3M extra rollbacks each). 10-01 is a counter reset (negative delta; unmeasurable). Since the 10-07 20:55 UTC snapshot, 10-08 is already at 28.7% (358k rollbacks) although a 10 s live sample at 09:41 UTC was quiet (about 2%), so the spikes are episodic, not constant.

## Ruled out / not the cause
- Cron: 24 h shows 3 failed runs of about 25k (all `email_queue_dispatch`). Not a rollback source at this scale.
- Explicit `ROLLBACK`/`ABORT` statements: about 70k of 2.69M. Most rollbacks are implicit aborts (statements that errored).
- Sign-in errors: `login_phase_events` error rate is flat across the day.
- Money: every ledger posting balances; nothing here shows lost writes.

## Why it can't be pinned from existing data
`pg_stat_statements` never records statements that error, and `db_stat_snapshots` is daily. Neither can localise a spike to an hour or workload.

## Instrumentation added
`capture_db_stat_hourly()` (cron `capture-db-stat-hourly`, minute 2 each hour) stores the hourly commit/rollback delta, backend count, and the 15 statements whose call count surged that hour in `db_stat_hourly` (30-day retention, service role only). After the next spike: `select captured_at, rollback_pct, top_statements from db_stat_hourly order by delta_rollback desc limit 5`.

## Next
Apply the migration, then wait for a spike hour. If the surge is realtime/PostgREST volume (e.g. `wal->>` or `pgrst_source` calls), the aborting client is an app loop to hand to Gemini; if a specific RPC surges, check it for `RAISE`/constraint errors.
