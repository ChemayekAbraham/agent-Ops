# 228 — Zero-float payout claims count as evidenced (2026-10-14)

**Status: MIGRATION WRITTEN, NOT APPLIED.** `20261014180000_zero_float_payout_claims_are_evidenced.sql`.

## Problem
`v_merchant_oop_evidence` marked a claim evidenced only if Finance attested it or the desk's float at the payout time was strictly negative. A zero-float desk sits at exactly 0 and a payout debits nothing, so claims never became payable. Test on Immaculate (BAITA, `1a88b1b8`), 14 Oct: 28 open rows, payable 0, under review 21,444,603. Contradicts the rule that a payout made before float arrives is the agent's own money.

## Change
Evidenced when position <= 0; at exactly 0 the evidenced amount is the whole shortfall; negative positions keep the old cap; positive positions unchanged (float covered them). Telecom claims with no provider reference stay `is_estimate` and excluded.

## Measured before writing
- Immaculate: +8,889,000 principal (12 rows; ~8,775,000 of it the 14 Oct test payouts). Telecom estimates (68,150) still excluded. Two positive-float rows (12,474,153) stay under review.
- All desks: 21 rows, UGX 20,385,681 on 3 desks move to payable. The view feeds `get_merchant_out_of_pocket_summary` and `settle_merchant_out_of_pocket`.

## Verify after applying
Immaculate: payable 8,889,000, 12 payable rows. Review the other two desks' rows before anyone settles them.
