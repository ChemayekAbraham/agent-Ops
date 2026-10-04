---
name: Consolidation Backlog (CTO Report vs SYSTEM_CONTEXT)
description: 11 prioritized architectural shortcomings from the CTO-report/SYSTEM_CONTEXT comparison; must be addressed ONE AT A TIME, never in bulk
type: preference
---
**RULE: These items must be addressed ONE BY ONE, never all at once in a single change.** Wait for the user to pick or confirm the next item before touching another. The next phase is consolidation, not new features: reduce duplication, simplify dependencies, eliminate repair jobs by making the primary path correct, and strengthen domain isolation so failures stay local.

Framing: the architecture is sound. The *implementation* has fallen behind the design. Every fix should move implementation toward the documented architecture, not redesign it.

## Backlog (open, unordered by priority beyond numbering)
1. **Cache reads vs ledger truth** — too many paths still write/read cached wallet balances instead of the ledger-derived strict view. Target: every read goes through the pivot view.
2. **Too many recovery jobs** — `reconcile-wallets-from-pivot`, `repair-wallet-cache-drift`, `wallet-projection-drift`, `refresh-wallet-cache`, anchored drift repairs. Consistency is being restored after the fact instead of prevented. Target: correct primary path, then delete repair jobs.
3. **Cron coupled to internal DB objects** — `reconcile-wallets-from-pivot` failed 145× because `v_pivot_drift` does not exist. A renamed view must never stop production. Target: stable contracts/wrappers + failure alerting.
4. **Function sprawl** — ~1002 RPCs, 382 triggers. One feature spread over dozens of objects. Target: consolidate per-domain service functions (e.g. one Advance service).
5. **Slow queries** — production RPCs at 48s / 24s / 16s. Analytical work on production paths. Target: materialized views / precomputed snapshots.
6. **Frontend robustness** — recurring Script Error, "Cannot destructure", Invalid Lazy Module, dynamic import failures. Target: null guards, retry, graceful degradation.
7. **Auth pipeline too complex** — 65% auth success. Gates: phone, name, roles, permissions, trust, KYC, frozen, device. Each gate multiplies failure probability. Target: collapse/defer gates.
8. **Reporting cost** — ~20 scheduled reports, 17-page CTO report recomputing daily. Target: reports consume precomputed data only.
9. **Scale/modularity** — 423 tables, 1002 RPCs, 382 triggers, 279 edge functions, 98 cron jobs. Architecture modular, implementation not. Target: decouple tightly coupled domains.
10. **Missing domain boundaries** — wallet reconciliation failures cascade into automation → reporting → dashboards → performance. Target: failures stay local.
11. **Acknowledged technical debt** — duplicate tables, overlapping cron jobs, retired triggers, historical classifications, documentation drift. Target: scheduled cleanup passes.