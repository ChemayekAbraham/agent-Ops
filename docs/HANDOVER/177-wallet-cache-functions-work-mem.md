# 177 — Wallet cache functions: work_mem to stop temp-file spills

## Status
**BUILT 2026-10-01, not yet applied.** Migration `20261001070000_wallet_cache_functions_work_mem.sql`. Check the live objects after Lovable applies it (see doc 06 on migrations diverging from production).

## Why
The 2026-09-30 CTO report listed slow statements spilling to temp files. Live `pg_stat_statements` on 2026-10-01 (since the 05:35 UTC restart):

| Function | Cron | Mean | Temp written per run |
|---|---|---|---|
| `refresh_wallet_totals_cache()` | job 2723, every 3 min | ~15.4 s | ~35 MB (72,347 blocks / 16 runs) |
| `repair_wallet_cache_drift(1000)` | job 5955, every 15 min | ~9.8 s | ~2 MB |
| `detect_wallet_projection_drift(1000)` | job 6427, every 15 min | ~9.7 s | ~2 MB |

Corrections to the report: `refresh_wallet_totals_cache` runs 480 times a day, about 2 database-hours a day. The report's 6,392 calls and 28 DB-hours figure was not reproduced.

## Change
`ALTER FUNCTION ... SET work_mem = '64MB'` on the three functions. Bodies, `search_path` and `statement_timeout` are untouched. No ledger or wallet math changes. None of the three is in `critical_function_baselines`, so no re-baseline was needed.

## Verify after apply
1. `select proname, proconfig from pg_proc where proname in (...)` shows `work_mem=64MB` next to the existing settings.
2. After a few cron runs, `pg_stat_statements` `temp_blks_written` for these statements stops growing and the mean drops. If it stays ~15 s, the cost is the double scan of `v_user_wallet_strict`, and the next step is a rewrite (delete-rebuild is the wrong policy here: it touches wallets, so patch and verify).
3. Memory: 64 MB per sort or hash node, with at most one of these running per cron slot. Negligible.

## Rollback
`ALTER FUNCTION public.<name>(<args>) RESET work_mem;`

## Architecture map
No update: a tuning setting on existing functions, no new subsystem or flow.
