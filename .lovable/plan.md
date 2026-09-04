# AOPS-EXP-01 — Report only: what the "Expected" tile touches

No changes proposed. This document is a verified file/line report.

## 1. Every file that calls or references `get_agent_collections_command_center`

| File | Line(s) | What it is |
|---|---|---|
| `src/components/executive/agent-ops-v2/AgentCollectionsCommandCenter.tsx` | 135 | The RPC call itself: `supabase.rpc('get_agent_collections_command_center', { p_start, p_end, p_bucket })` |
| `src/components/executive/FleetPerformanceStats.tsx` | 719, 727 | Comment (719) and a second RPC call site (727) — the Fleet page reuses the same RPC for its EXPECTED / COLLECTED / COLLECTION RATE cards |
| `src/integrations/supabase/types.ts` | 45775 | Generated type entry for the RPC (auto-generated file) |

Callers of the component (mount points, not RPC callers): `src/components/executive/AgentOpsDashboard.tsx` line 23 (import) and line 323 (`case 'performance': return <AgentCollectionsCommandCenter />`); `src/pages/coo/Dashboard.tsx` line 10 (import) and line 153 (render).

## 2. Expressions behind the "Expected" tile

File: `src/components/executive/agent-ops-v2/AgentCollectionsCommandCenter.tsx`

- The displayed number comes from a **client-side sum over the per-agent array**, not a totals field:
  - Line 210: `const expectedTotal = agents.reduce((s, a) => s + a.expected, 0);`
  - Each `a.expected` is coerced at line 178: `expected: num(a.expected),`
  - Rendered at line 339: `{formatUGX(expectedTotal)}`
- The "% of expected" progress bar:
  - Line 263: `const coverage = expectedTotal > 0 ? Math.round((collectedTotal / expectedTotal) * 100) : null;` (with `collectedTotal` at line 262: `num(totals?.collected)`)
  - Bar at line 341: `<Progress value={Math.min(100, coverage ?? 0)} className="h-1.5" />`
  - Caption at line 342: `` `${coverage}% of expected` `` (or "No expectation on record" when null)
- The same sum is also used for the PDF statement export at line 225: `expected: agents.reduce((s, a) => s + a.expected, 0),`

## 3. The four-tile row and its wrapper

File: `src/components/executive/agent-ops-v2/AgentCollectionsCommandCenter.tsx`

- Line 331: `<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">` — the KPI strip wrapper (a plain CSS grid, not a dedicated component).
- Tiles, each a `<Card className="p-3">`: Collected lines 332–336, Expected lines 337–344, Active agents lines 345–349, New rent requests lines 350–354.
- Adding a fifth tile is trivially easy: it is a plain grid with four sibling `<Card>` children. Changing to `lg:grid-cols-5` and adding one more `<Card>` is all that is required; there is no fixed-column constraint beyond that class.

## 4. Every other repo reference to `v_agent_daily_eligibility` or `agent_daily_eligibility_history`

- `src/components/executive/AgentDailyOverviewReportButton.tsx` line 140: `.from('v_agent_daily_eligibility')`
- `src/components/payments/WithdrawFlow.tsx` line 297: `.from('v_agent_daily_eligibility' as any)` (line 318 is a comment about its `today_pct`)
- `src/components/wallet/SendMoneyDialog.tsx` line 159: `.from('v_agent_daily_eligibility')`
- `src/hooks/useAgentCapacityMap.ts` line 364: `.from('agent_daily_eligibility_history')` (lines 56, 308, 421 are comments referencing the view)
- `src/hooks/useAgentEligibilityHistory.ts` lines 32 and 66: `.from('agent_daily_eligibility_history')`
- `src/lib/agentRentCollectionsPdf.ts` line 76: `.from('agent_daily_eligibility_history')`
- `src/components/agent/PriorityCollectionQueue.tsx` line 60: comment only
- `src/lib/collectibleRentRequests.ts` lines 4, 28: comments only (mirrors the view's law)
- `src/integrations/supabase/types.ts`: generated type entries (auto-generated)

## 5. Client-side recomputation of expected — yes, two places

**a) In the Command Center itself** — the tile is a pure sum of RPC `agents[].expected` (line 210), so no per-day multiplication happens in this component. Any daily×days multiplication is inside the RPC.

**b) In FleetPerformanceStats.tsx there IS TypeScript multiplication of a daily figure by a day count:**
- Line 758: `const expected = (expectedByAgent[id] || 0) * days;` — per-agent row expected.
- Line 800: `const localExpected = rows.reduce((s, r) => s + r.expected, 0);` — sums those multiplied rows (note: line 802–803 shows the headline EXPECTED card actually prefers the RPC: `totalExpected = commandCenter ? commandCenter.agents.reduce(...) : localExpected`).
- Lines 961–963: `expectedPerDay = Object.values(expectedByAgent).reduce(...)` (sum of daily targets).
- Trend series multiplies: line 973 `const expectedPerHour = expectedPerDay / 24;`, line 989 `expected: expectedPerDay * dCount`, line 998 `expected: expectedPerDay`.
- The daily input itself is computed client-side from `rent_requests`, NOT from the RPC: `fetchExpectedDailyByAgent` (lines 356–378) paginates `supabase.from('rent_requests').select('agent_id, daily_repayment').in('status', ACTIVE_RENT_STATUSES)` and sums `daily_repayment` per agent.

## Not found / notes

- `totals.expected` does not exist anywhere in the frontend; confirmed the Expected tile never reads a totals field — it always sums `agents[].expected` (or, on FleetPerformanceStats, falls back to the locally multiplied figure when the RPC hasn't loaded).
- No other file references the RPC string.
