---
name: Sub-agent collection rankings
description: Service Center leaderboard ranking a manager's sub-agents on rent repayments collected, collection rate or outstanding arrears — derived client-side from the roster RPC, no query of its own
type: feature
---
Rankings section on the **Team** tab of `/agent/service-center` (`src/pages/AgentServiceCenter.tsx`), rendered by
`SubAgentRankingsBoard` above the roster cards. Collapsible, open by default.

Data source: **none of its own.** It is a pure projection of `useServiceCenterOverview()` →
`get_agent_service_center().sub_agents[].tenant_list[]`, which already carries `total_repayment`,
`amount_repaid`, `daily_repayment`, `is_active` and `owned_by_subagent`. The board therefore costs zero extra
round trips and can never disagree with the roster or detail sheet beside it.

Maths lives in `src/lib/subAgentRankings.ts` (React-free, unit-tested in `src/lib/subAgentRankings.test.ts`).

Credit rule — `isCollectiblePlan()`. A rent plan counts toward a sub-agent only when:
- `owned_by_subagent !== false` — referral-only rows belong to the agent who owns the plan, so counting them
  would credit the same shillings to two sub-agents. Absent (older payloads) is treated as owned.
- `rent_request_id` is a real id, not `null` and not a `profile:<uuid>` placeholder (a referred tenant with no
  rent request has nothing to collect).
- `is_active === true` OR `amount_repaid > 0` — plans still in vetting or rejected never disbursed; including
  them would inflate `expected` and drag down an innocent sub-agent's rate.

Per-sub-agent figures: `collected` (Σ amount_repaid), `expected` (Σ total_repayment),
`outstanding` (max(0, expected − collected)), `collectionRate` (collected/expected × 100, **null** when nothing
is due so "no data" never renders as 0%), `dailyTarget` (Σ daily_repayment over active plans),
`plans` / `activePlans` / `clearedPlans`.

Three ranking metrics, highest score first in all three:
- `collected` (default) — rent repayments banked. Podium styling (crown/medal/award on ranks 1-3).
- `rate` — share of what is due that came in; sub-agents with nothing due score −1 so they sort below everyone
  who has real collections rather than above everyone at 0%. Podium styling.
- `outstanding` — biggest arrears first, i.e. a follow-up queue. **No podium styling**: rank 1 is not a winner.

Ties share a rank (1, 1, 3) and are ordered by collections then name, so the board does not reshuffle between
refetches. Team totals in the header recompute the rate from summed totals — never an average of row rates.

Tapping a row calls back into the page's existing `setDetailId`, opening the same `SubAgentDetailSheet` the
roster cards use. Top 5 shown by default with a "Show all N" expander.

Tests: `src/lib/subAgentRankings.test.ts` (maths, credit rules, ties, stability) and
`SubAgentRankingsBoard.test.tsx` (order per metric, metric switching, row tap, paging, collapse, and the
loading / error / empty / nothing-collected-yet states). Shared roster fixtures in
`src/test/fixtures/serviceCenter.ts`.
