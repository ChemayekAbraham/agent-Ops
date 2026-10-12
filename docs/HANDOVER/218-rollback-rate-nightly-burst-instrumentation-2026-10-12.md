# 218 — Rollback rate 22.2%: one nightly burst, not a steady fault (2026-10-12)

**Status: BUILT, migration `20261012130000` not applied. Root cause not yet identified.**

## Finding
CTO report 10-11 shows 22.2% rollbacks (309,200 / 1,394,574). That is a true 24h delta, but it comes from a single hour, not from the day.

`db_stat_hourly` (EAT, delta_rollback / rollback_pct):

| Hour ending (EAT) | Rollbacks | % |
|---|---|---|
| 10-09 03:02 | 386,467 | 92.4 |
| 10-10 06:02 | 303,286 | 92.9 |
| 10-11 03:02 | 260,251 | 91.5 |
| 10-11 06:02 | 36,173 | 58.9 |

All other hours: 0.2–2.5% (about 100–1,700 rollbacks/hour). Commit volume in the burst hours is normal (about 24k), so something fires roughly 85 failing transactions per second for about an hour. Live minute sample 10-12 07:20 UTC: 56 rollbacks vs 3,595 commits (1.5%).

## Ruled out
- Cron: zero failed runs in 24h; same job mix inside and outside the burst windows.
- `login_phase_events` / `audit_logs`: no volume spike in the burst hours.
- Explicit `ROLLBACK` in `pg_stat_statements`: ~90k + 44k lifetime, far too few. The bursts are implicit (statement errors).

## Why it is still open
Failed statements never appear in `pg_stat_statements`, and the burst ends before anyone looks. `capture_rollback_minute()` (cron `capture-rollback-minute`, every minute) records per-minute deltas, and when a minute exceeds 1,500 rollbacks it stores the non-idle backends by role/app, up to 25 running statements, and running cron jobs in `db_rollback_burst_evidence`.

## Next step
After the next burst, read `db_rollback_burst_evidence`, identify the caller, and fix at source. Until then do not read the report's 22.2% as ongoing load, and do not pg_stat_reset (it would also reset table stats used by autovacuum).
