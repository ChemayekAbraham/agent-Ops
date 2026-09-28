# Live withdrawable credits — CFO dashboard section

## What you get
A new "Withdrawable credits today" section on the CFO dashboard that:
- Shows today's (Nairobi day) total money credited to users' withdrawable balance, split by type: Supporter returns, deposits, wallet transfers in, commissions, salary/payroll, bonuses, corrections, other.
- Each type shows total UGX and number of credits, plus a grand total.
- Updates by itself within seconds when a new credit posts (no refresh needed), with a "last updated" time.
- Read-only: no money, wallets or ledger rules change.

## Technical details
- New read-only SECURITY DEFINER RPC `get_cfo_withdrawable_credits_today()` (search_path = public), restricted to CFO/CEO/super_admin via `has_role`. Aggregates `general_ledger` where `wallet_bucket = 'withdrawable'`, `direction = 'cash_in'`, dated today (Africa/Kampala), grouped by category into friendly groups. Columns verified against the live schema before writing.
- New hook `useWithdrawableCreditsToday` (React Query) + a single realtime subscription on `general_ledger` inserts, set up in `useEffect` and removed on unmount; inserts trigger a debounced refetch (max once per 5s) instead of polling. If realtime is not enabled on the ledger, fall back to a 30s refetch rather than adding the huge ledger table to realtime.
- New component `src/components/cfo/WithdrawableCreditsLivePanel.tsx`, placed on the CFO dashboard overview.
- Copy uses "Returns"/"Supporter" terminology; amounts via `formatUGX`.
- Verify: guard:all, typecheck, live render as CFO.
