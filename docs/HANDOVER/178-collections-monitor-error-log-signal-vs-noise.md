# 178 — Agent Collections error log: signal vs noise

## Status
**BUILT 2026-10-01, not yet applied.** Migration `20261001080000_collections_monitor_error_log_signal_vs_noise.sql`. Verify the live function bodies after Lovable applies it (doc 06).

## Why
`/cto/dashboard?section=monitor-agent-collections` showed 300+ errors (about 430 over 14 days). Grouped by cause, live on 2026-10-01:

| Cause | Rows | Verdict |
|---|---|---|
| IndexedDB "connection is closing" (+ related IDB) | ~210 | Stale browser tabs. 83 rows are one user whose stack names `fieldCollectStore-rxGmIFnf.js`, which now returns 404. Current code (docs 142, 151) already handles it. |
| `INSUFFICIENT_TID_BACKED_FLOAT` | 46 / 13 agents | The 2026-09-21 TID-backed float rule working as designed. |
| `Cannot read properties of undefined (reading 'Agent…')` | ~70 | Fixed in code by `lazyNamed`; remaining rows are stale-chunk browsers. |
| Leaflet `_leaflet_pos` | ~50 | Fixed; newest row 2026-09-24. |
| Browser noise | ~62 | Not a collection fault. |
| Small unknowns (`Write permission denied`, `reading 'target'`, `'id'`, `'replace'`) | ~25 | To be traced one by one (separate docs). |

## Change
`agent_collections_error_log` and `agent_collections_error_summary` (same live bodies, same signatures):
1. `INSUFFICIENT_TID_BACKED_FLOAT` engine rows are shown as severity `info`. They are still listed and counted so FinOps can see who is blocked.
2. The `app` source excludes `Failed to fetch%`, `Script error%`, `%writeText%Clipboard%`, `Copy is not available%`, `ResizeObserver loop%`.

Neither function is in `critical_function_baselines` (checked live), so nothing to re-baseline. The panel's TypeScript is unchanged (`info` is already in its severity map).

## Honest limit
"Failed to fetch" is a real network failure on an agent's device (22 rows / 2 agents). It is hidden because it names no collection fault and cannot be acted on from here. Remove that line if you want connectivity problems visible.

## Verify after apply
1. `select severity, count(*) from agent_collections_error_summary(14) group by 1` (as a CTO session): the engine `info` bucket holds the TID-float rows; the `app` total drops by about 62.
2. After tabs reload, the IDB and `lazyNamed` clusters stop growing.

## Rollback
Re-apply the bodies from `20260928170000_collection_error_reporting_depth.sql` / `20260929170000_close_float_gate_incident_on_collections_monitor.sql`.

## Architecture map
No update: filtering inside two existing reporting RPCs.
