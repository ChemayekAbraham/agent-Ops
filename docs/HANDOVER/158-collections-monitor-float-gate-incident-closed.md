# 158. Agent Collections Monitor: 15–16 Sep float-gate incident closed, double-count removed (2026-09-29)

**Status:** LIVE 2026-09-29. Applied to production. Migration file:
`supabase/migrations/20260929170000_close_float_gate_incident_on_collections_monitor.sql`.
**Page:** CTO dashboard → `?section=monitor-agent-collections` (`AgentCollectionsMonitorPanel.tsx`).
**This is issue #1** in a one-at-a-time pass over everything that page shows.

## What the page showed

Error log, 30-day window:

| Source · severity | Hits | What it really was |
| --- | ---: | --- |
| engine · critical (`FLOAT_NOT_CONSUMED`) | 659 | the same 659 collections as the next row |
| anomaly · high (`float_leg_missing`) | 659 | genuine collections inside the 15–16 Sep float-gate window |
| anomaly · critical (`float_direction_inverted`) | 1 | 10 Sep incident, acknowledged 09-27 as already restored |

All 660 anomaly rows share a single `detected_at` of 2026-09-27 17:01:35, which was the detector's first run. They are
not 660 new events.

## What the 659 are

The collections that sit inside the incident window
(2026-09-15 15:12:23 → 2026-09-16 15:16 UTC,
[`docs/2026-09-15-float-gate-collection-incident.md`](../2026-09-15-float-gate-collection-incident.md)),
when drizzle 0114 made float a non-consuming gate:

- 38 agents, 324 Rent Plans, **UGX 56,946,270**, none reversed. All are on the `agent_float` channel, with
  `float_before = float_after` on every one.
- The tenants were credited (via the incident's `20260916200000` tenant credit, or directly after
  the guard fix).
- **No float was ever consumed for them**, and nothing has been posted since to back-charge it.
- The ledger for that window shows `cash_receipt_in_transit` (A5) cash_in of UGX 149,759,953. The
  incident's `20260916220000` contra removed only the duplicates' 92,656,683. That leaves
  **about UGX 57M of A5 custody that nothing will ever clear.**
- Those 38 agents now hold UGX 1,088,009 of float between them, and none of them is negative.
  A float clawback would recover under 2%.

The engine row double-counted these because the `float:` branch of `agent_collections_error_log` /
`agent_collections_error_summary` reads `agent_collections` directly and never consulted
`tops_collection_anomalies`.

## Decision

Josh Wanda, 2026-09-29: **"close it."** Implemented as closing the item on the monitor only:

1. All 659 `float_leg_missing` anomalies within the window are set to `resolved`, and the one
   acknowledged `float_direction_inverted` row is also set to `resolved`. `resolved_by` is Josh, and each
   `resolved_note` points here.
2. The `float:` engine branch in both RPCs now skips any collection that already has a
   `float_leg_missing` anomaly row. While the anomaly is open it is reported there; once resolved it is
   closed. A new stale-float collection still shows as engine critical until the 10-minute
   detector (`tops-detect-collection-anomalies-every-10min`) catches it, so the early warning is kept.

**No ledger posting was made.** No float was clawed back and no write-off contra was posted. The ~57M of A5
custody is left for Finance. If the intent was a write-off, it needs a balanced `production`
contra of A5 against the loss account, the same shape as `20260916220000`. That has not been done.

## Verified after apply

The page's own RPCs, run as a CTO user over 30 days:

| | Before | After |
| --- | ---: | ---: |
| engine · critical | 659 | **0** |
| anomaly · high | 659 | **0** |
| anomaly · critical | 1 | **0** |
| engine · warning (TID-backed float refusals) | 10 | 10 |
| app · warning | 871 | 873 (new crashes arriving; issues #2–#3) |

## Remaining on this page (next, one at a time)

2. Agent app: IndexedDB "database connection is closing" (21, 28 Sep 15:31–17:03).
3. Agent app: "Cannot read properties of undefined (reading 'AgentTenantsSheet' / …)", a lazy-screen
   load failure.
4. "Write permission denied" (2) and `INSUFFICIENT_TID_BACKED_FLOAT` (10, probably the TID rule working).
5. Health checks: plan balance holds reversed money (26 plans, 10.76M), plan overpaid (2, 265k),
   reversed collections countable (1,273), possible duplicates (29), missing commission (27),
   collections on dead plans (12), plus the two info-level rate checks.
