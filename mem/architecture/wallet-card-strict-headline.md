---
name: Wallet card strict headline
description: UnifiedWalletHeroCard headline shows ledger-strict available, not cached wallets.balance, so pending withdrawals immediately reduce the visible balance
type: feature
---
The "Available Balance" headline on `UnifiedWalletHeroCard` (used by tenant, supporter, landlord dashboards — non-agent layouts) is sourced from `useAvailableBalance` → `get_user_available_balance` RPC. The cached `wallets.balance` prop is only used for the agent split layout's Total row and as a "Wallet total" sub-line when a pending hold exists.

`useAvailableBalance` was previously broken: the RPC returns a scalar `numeric`, but the hook treated the response as an object and read `r.available` (always 0). Fixed 2026-04-29 to handle both shapes and to fetch `walletCached` from `wallets.withdrawable_balance/balance` separately.

Also subscribes to realtime changes on `wallets`, `withdrawal_requests`, and `general_ledger` (filtered by user_id) so the card refreshes the moment a withdrawal is submitted, approved, rejected, or cancelled — no manual reload required.

When `walletCached − available > 0`, the card shows an amber "X pending withdrawal" badge and a "Wallet total" sub-line so users understand why their available balance is lower than their total. This eliminated the "I withdrew but balance didn't decrease" confusion that occurred between request → manager_approved → fin_ops_approved (during which `wallets.balance` is still untouched but the RPC already subtracts the pending request).
