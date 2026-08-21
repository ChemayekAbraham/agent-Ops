---
name: Merchant owed = point-in-time ledger deficit only
description: A merchant out-of-pocket claim only counts as money owed when merchant_float_position_at shows the desk negative at that payout's own timestamp; claims must display payout time, TID, recipient name and phone
type: constraint
---
Since 2026-08-20:

- `merchant_float_position_at(agent_id, at)` reconstructs a desk's float from `general_ledger`
  wallet/float legs up to that instant, ignoring `admin_correction` and `system_balance_correction`.
- `v_merchant_oop_evidence` (security_invoker) is the single read surface for merchant
  out-of-pocket claims: per claim it exposes `payout_at`, `payout_tid`, `recipient_name`,
  `recipient_phone`, `provider`, `float_position_at_payout`, `is_estimate`, `is_evidenced`,
  `evidenced_amount`.
- `get_merchant_out_of_pocket_summary` and `get_merchant_float_positions.owed_to_agent` count a
  `pending_reimbursement` claim ONLY when `float_position_at_payout < 0` and the row is not an
  estimated telecom charge. Unsupported confirmed claims are reported as under review /
  `unsupported_total`, never as owed. Never use lifetime paid-out minus float credits.
- Every displayed claim must name the payout: date and time, TID, recipient name and phone,
  amount fronted, and the desk's float position at that moment.
- The 2026-08-20 effect: Emma Maiso's stale UGX 3,894,379 dropped to 0 owed with no data,
  wallet or ledger writes. Fleet-wide evidenced owed = UGX 0.
