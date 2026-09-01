---
name: Merchant owed is ledger-derived only
description: owed_to_agent in get_merchant_float_positions comes from negative ledger float plus point-in-time-evidenced out-of-pocket claims — never lifetime paid-out minus float credits, and never a raw pending_reimbursement status filter alone
type: constraint
---
`get_merchant_float_positions()` (corrected 2026-08-19, evidence check added 2026-08-29):

- `owed_to_agent = GREATEST(0, -float_balance_raw) + unbacked`, where `unbacked` sums
  `merchant_out_of_pocket_advances.shortfall_amount` for rows with `status='pending_reimbursement'`,
  `reimbursed_at IS NULL`, **and** `merchant_float_position_at(agent_id, payout_at) < 0` — the desk must
  reconstruct negative at the payout's own timestamp, not just carry the right status.
  NEVER `paid_out_total - float_credits_recorded` — that differential produced a false
  UGX 88,203,296 platform liability.
- `paid_out_total` counts only `payout_method='mobile_money'` completed withdrawals (bank transfers
  never consume a merchant's phone float) and attributes each withdrawal to exactly ONE desk
  (assigned desk first, else the processing agent's desk) — the old OR-join double counted 10 payouts.
- `payouts_without_float_evidence` counts confirmed out-of-pocket claims only, not
  `merchant_payout_funding` auto-classifications (`classified_via='reconciler'` inflated it to ~260m).

**Superseded (as of 2026-08-29, `20260829140000`): a claim no longer needs attestation or review to
reach `pending_reimbursement`.** `classify_merchant_payout_funding` files a fronted own-cash claim
straight into `pending_reimbursement` the moment a completed payout proves company float didn't cover
it — attestation (`attested_at`) and Finance review (`reviewed_at`) still exist and are recorded, but
neither is the gate that decides whether the debt exists any more; see
[[project-merchant-oop-attestation-gate-hides-debt]]. What decides whether a `pending_reimbursement`
row counts as real money owed is the point-in-time ledger check above (or, for `v_merchant_oop_evidence`
and the settlement dialog, `is_evidenced` / an explicit `evidence->>'finance_attested'`).

**Known drift risk**: this evidence check now exists as THREE independent implementations that must be
read and audited together, not one shared function — `get_merchant_float_positions`'s `unbacked` CTE,
the `v_merchant_oop_evidence` view (adds the finance-attestation escape valve and per-claim
`evidenced_amount`), and `settle_merchant_out_of_pocket`'s own inline copy (added 2026-09-01,
`20260901090000`, after the RPC was found paying a claim's full `shortfall_amount` on any
`pending_reimbursement` row with no evidence check at all — see
[[project-merchant-oop-settlement-rpc-evidence-gap]]). If the evidence formula changes again, all three
call sites need updating, or the board figure, the settlement dialog, and what actually gets paid can
disagree with each other.

No wallet or ledger writes happen in `get_merchant_float_positions` or `v_merchant_oop_evidence` — only
`settle_merchant_out_of_pocket` and `review_merchant_out_of_pocket` write, both SECURITY DEFINER.
