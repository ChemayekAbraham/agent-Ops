# 233 — Lazy-chunk errors in the collection-error export are stale cached bundles (2026-10-15)

**Status:** investigation only. No code, migration or data changed.

## What the export showed
Four `/dashboard/agent` rows from `agent-collection-errors-all-7d-20261015-0921.csv`:

| When (UTC) | Message | Agent bundle that threw |
|---|---|---|
| 10-09 09:45 | `reading 'AgentLandlordFloatAllocationsDialog'` | `AgentDashboard-BI2_0QbK.js` |
| 10-09 16:35 | `reading 'AgentListingsSheet'` | `AgentDashboard-B1hUUU_B.js` |
| 10-13 07:59 | `reading 'AgentTenantsSheet'` | `AgentDashboard-DHNSvHvn.js` |
| 10-12 15:58 | `Unhandled promise rejection` (no stack, iPhone) | n/a |

The first three are the old `lazy(() => import('./X').then(m => ({ default: m.X })))` mapper meeting a chunk that resolved to `undefined`.

## Why nothing needs fixing
- `src/components/dashboards/AgentDashboard.tsx` has used `lazyNamed(...)` for all three since `a637d29012` (2026-09-30, the fix for the 09-30 CTO report, ~70 hits). `lazyNamed` never dereferences the module unguarded and does one guarded reload.
- Live check 2026-10-15: `welileapp.com` serves `Dashboard-CALm-ILr.js` → `AgentDashboard-xz65hqmk.js`, where `AgentTenantsSheet` is declared through the guarded wrapper (`...import("./AgentTenantsSheet-DNESltrq.js"),...),"AgentTenantsSheet")`), no `.then` mapper.
- The three thrown bundles are older hashes than the live one. They come from phones still holding a pre-fix build (the same Android 10 "K" device class in two of them), not from a defect in the current build.
- The remaining `.then(m => ({ default: m.X }))` sites in `src/App.tsx` are wrapped in `optionalLazyWithRetry`, which catches and renders nothing.

## Not actionable
The single unhandled rejection has no message, stack or component; nothing to trace.

## If it recurs
Compare the failing bundle hash against the live one. A hash that matches live would mean the guard is bypassed and is a real bug. An older hash means stale cache only.
