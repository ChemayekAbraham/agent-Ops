---
name: Merchant owed = point-in-time ledger deficit only
description: A merchant out-of-pocket claim only counts as money owed when merchant_float_position_at shows the desk negative at that payout's own timestamp; the point-in-time reconstruction sums EVERY float leg (including admin_correction / system_balance_correction) since 2026-08-25
type: constraint
---
Since 2026-08-20 (point-in-time evidence rule), corrected 2026-08-25 (symmetric inclusion):

- `merchant_float_position_at(agent_id, at)` reconstructs a desk's float from **every**
  `general_ledger` wallet-scope, `wallet_bucket='float'` leg dated `<= at` — including
  `classification='admin_correction'` and `category='system_balance_correction'` legs.
  Excluding those (the 2026-08-20 behaviour) was asymmetric: upward manual balance sets
  (`post_merchant_opening_float_ledger`, tagged `production`/`agent_float_deposit`) counted,
  while downward manual write-downs (tagged `admin_correction`) were ignored — so a desk that
  had been correctly written down to 0 still read as fully funded and genuine company debt to
  merchant agents was hidden (Sky Bubbles / BAITA read +13,781,741 instead of 0, suppressing a
  UGX 7,500,000 claim). The function now matches what the books actually said at that instant
  and reconciles exactly with `wallet_balances_projection.float_balance_raw` at `now()`.
- `v_merchant_oop_evidence` (security_invoker) is the single read surface for merchant
  out-of-pocket claims: per claim it exposes `payout_at`, `payout_tid`, `recipient_name`,
  `recipient_phone`, `provider`, `float_position_at_payout`, `is_estimate`, `is_evidenced`,
  `evidenced_amount`.
- `get_merchant_out_of_pocket_summary`, `get_merchant_oop_evidenced_owed` and
  `get_merchant_float_positions.owed_to_agent` count a `pending_reimbursement` claim ONLY when
  `float_position_at_payout < 0` and the row is not an estimated telecom charge. A desk sitting
  at exactly 0 float that fronted cash without a float debit leg is therefore still not
  evidenced. Unsupported confirmed claims are reported as under review / `unsupported_total`,
  never as owed. Never use lifetime paid-out minus float credits (the pre-2026-08-20 formula).
- Every displayed claim must name the payout: date and time, TID, recipient name and phone,
  amount fronted, and the desk's float position at that moment.
- Historical note: the 2026-08-20 change correctly replaced the old lifetime paid-out-minus-float-credits
  formula with point-in-time evidence, but its exclusion of correction legs produced the now-superseded
  Emma Maiso UGX 3,894,379 → 0 result. The 2026-08-25 symmetric-inclusion fix keeps the point-in-time
  model while counting both write-ups and write-downs from the ledger.
- Known accepted residual risk: upward manual opening-balance assertions still count as
  evidence of funding (production-tagged path), so a careless large opening-balance entry can
  still make a desk look wrongly funded. Deliberately out of scope for the 2026-08-25 fix.
