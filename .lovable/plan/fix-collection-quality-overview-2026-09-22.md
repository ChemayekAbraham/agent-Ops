# Fix Collection Quality Overview

## What will change
- Add one read-only database calculation for the last 14 Kampala calendar days.
- Match each pinned daily Rent Plan bill to all non-reversed settlements for the same plan and Kampala day.
- Count each pinned bill once: full when settled amount meets the bill, partial when some is paid, and missed when nothing is paid.
- Calculate shortfall from the unpaid portion of pinned bills.
- Replace the browser-side multi-query calculation with this single uncapped result, removing record and tenant limits.

## Technical details
- Implement a `SECURITY DEFINER`, operations-role-gated RPC returning daily and total JSON data.
- Use half-open Kampala timestamps for settlement matching and `agent_expected_day_plans.day` for the pinned schedule.
- Aggregate multiple receipts per plan/day before classification and exclude reversed or non-positive collections.
- Update only the chart data handler in `AgentOpsOverview.tsx`; preserve the existing visual design.
- Validate the RPC against direct read-only totals, run type checks and safeguards, then verify the live dashboard chart.
