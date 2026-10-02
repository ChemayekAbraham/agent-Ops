# 189 — Agent "Personal advance" now matches the CFO's outstanding advance

**Date:** 2026-10-02 · **Scope:** `src/hooks/useAgentCompanyExposure.ts` (frontend read only, no migration, no edge function)

## Problem
The CFO dashboard (`AgentAdvancesOutstandingPanel`) totals `agent_advances.outstanding_balance`
for `status in (active, overdue)` and `outstanding_balance > 0`. The agent dashboard's
"My Tenants — Money Summary" card showed `wallets.advance_balance` as "Personal advance (wallet)",
a different source. Wallet and advance statements are known not to reconcile for many advances
(see doc 154), so the two dashboards showed different numbers for the same agent.

## Fix
`useAgentCompanyExposure` now reads the agent's own `agent_advances` rows with the identical
filter the CFO panel uses (active + overdue, balance > 0) and sums `outstanding_balance`.
`advanceBalance` and `totalOwed` derive from that. `AgentMyAdvancesCard` already read the same table
(non-cancelled, non-completed), so it agrees too.

## Not changed
- `wallets.advance_balance` is still what the wallet sheet and withdraw flow use for withdrawable
  maths. That is a wallet figure, not the debt headline.
- Any residual gap between wallet and statement is the doc-154 reconciliation work, not this change.

## Verify
For any agent, CFO panel row total == agent dashboard "Personal advance" == "My Advances" outstanding.
