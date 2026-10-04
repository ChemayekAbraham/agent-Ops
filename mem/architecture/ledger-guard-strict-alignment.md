---
name: Ledger guard solvency must match strict-withdrawable
description: The inner solvency check inside create_ledger_transaction MUST mirror get_user_available_balance — it cannot exclude system_balance_correction or admin_correction, otherwise legitimate CFO direct credits and corrections become "phantom" funds that show in the wallet, pass the strict gate, but get refused at posting time.
type: constraint
---
**Rule.** The `cash_out` solvency guard inside `public.create_ledger_transaction` MUST mirror `public.get_user_available_balance` exactly:
- filter by `user_id`, `ledger_scope='wallet'`, `classification IS NULL OR classification='production'`
- honor the per-user `wallet_fresh_start_anchors.anchor_at` (skip pre-anchor rows)
- exclude float-bucket categories (`agent_float_deposit`, `agent_float_used_for_rent`, `agent_float_settlement`, `partner_funding`) — these are company liability, not user withdrawable
- cap by the cached `wallets.withdrawable_balance`
- MUST NOT add `category <> 'system_balance_correction'` or `classification <> 'admin_correction'` filters — admin corrections are real backing for balance math

**Why.** Per the user-facing-ledger-filter rule, those exclusions apply to *display* surfaces only. Balance computations (strict gate, wallet-truth view, withdrawable cap) all count corrections as real backing. If the inner guard disagrees, the system enters a state where:
- Wallet shows the credit (cache + strict gate agree).
- The user initiates a withdrawal — passes the manager-side strict balance check.
- `create_ledger_transaction` then refuses the debit with `Insufficient ledger balance ... Available: -X` because it phantom-shrinks the user's balance.

**Fixed 2026-05-04** (admin-correction filter). **Re-aligned 2026-05-04** to also honor the fresh-start anchor + float-category exclusion + cached-withdrawable cap. Symptom that triggered the second fix: SSENKAALI PIUS had strict-available 75,000 UGX but the inner guard summed unanchored historical float operations to a net of −5,770,857 UGX and rejected legitimate 25,000 UGX merchant payouts with `Insufficient ledger balance`.
