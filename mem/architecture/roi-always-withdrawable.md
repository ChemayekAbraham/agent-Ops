---
name: ROI always routes to withdrawable
description: Partner returns (roi_wallet_credit / roi_payout) must ALWAYS bucket as withdrawable, even for agent+supporter dual-role users
type: constraint
---
`wallet_route_for_category(uuid, category, direction)` MUST NOT include `roi_wallet_credit` or `roi_payout` in the agent→float credit override list. ROI is supporter income by definition; routing it to float makes the funds non-withdrawable and breaks proxy partner withdrawals.

Bug history (2026-05-13): KATO KIYINGI ALLAN (agent + supporter) had a 75K ROI credit silently parked in `float_balance`; agent's proxy withdrawal failed with "Insufficient proxy partner balance (ledger-checked)". 25 dual-role users were affected and were repivoted via `recompute_wallet_buckets` logic.

If you ever re-add agent-routing overrides, NEVER include ROI categories. Verify with: `SELECT * FROM wallet_route_for_category('<dual-role-uid>'::uuid, 'roi_wallet_credit', 'cash_in')` — must return `('withdrawable', 1)`.
