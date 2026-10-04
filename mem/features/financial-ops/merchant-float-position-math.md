---
name: Merchant float position math + corrections
description: How "Money With Agents" computes owed vs holding for merchant agents, and the merchant_float_reconciliations correction path
type: feature
---
`get_merchant_float_positions()` (anchor date from `treasury_controls.merchant_float_anchor_date`, default 2026-08-01):

- `paid_out_total` — completed `withdrawal_requests` attributed to the desk (assigned desk or processed_by agent) since anchor.
- `float_credits_recorded` — real company money sent to the merchant: `general_ledger` legs with `wallet_bucket='float'`, `direction='cash_in'`, `category='agent_float_deposit'`, classification <> admin_correction. THIS is the authoritative reimbursement figure.
- `email_matched_total` — matched outgoing MTN/Airtel `gmail_transactions` — EVIDENCE ONLY, never added to reimbursement (it is the same money as the float credit; adding both double counted and previously showed a false "we owe agents UGX 384m").
- `adjustments_total` — signed sum from `merchant_float_reconciliations` (`payout_correction` counts negative).
- `reimbursed_total = float_credits_recorded + adjustments_total`; owed / holding are the two non-negative sides of `paid_out_total - reimbursed_total`.

Corrections: `merchant_float_reconciliations` (types `opening_balance`, `reimbursement_recorded`, `payout_correction`, `write_off`) requires a reason of ≥10 chars, insert restricted to CFO/financial_ops/manager/super_admin. UI: "Correct" button per row in `MoneyWithAgentsCard` → `MerchantReconcileDialog`. No wallet or ledger writes anywhere in this path.
