# 164. "Tenant repaid more than the plan total": the clamp ran before the total was recalculated (2026-09-29)

**Status:** LIVE 2026-09-29. Applied to production. Migration: `20260929190500_clamp_amount_repaid_after_formula.sql`.
**This is issue #6** from the Agent Collections Monitor pass (docs 158–161).

## What the monitor showed

Two plans, UGX 265,731, both **Kalule Brian's** (agent James Katongole; landlord history in doc 128):

| Plan | Total after resize | Repaid | Excess | Live collections |
| --- | ---: | ---: | ---: | ---: |
| `39976d4a…` (8 Sep) | 712,223 | 847,223 | 135,000 | 77,223 |
| `39131647…` (26 Aug) | 661,283 | 792,014 | 130,731 | 0 |

## Cause

On 2026-09-24 11:46–11:47 Janehephzibar Gimono resized both plans down to a UGX 600,000 rent. The formula
recalculated `total_repayment`, and `amount_repaid` was reduced by round figures (900,000 and 1,900,000), which left
both above the new total.

`clamp_rent_request_amount_repaid` exists to stop exactly this. But BEFORE triggers fire in **name order**, and
`trg_clamp_…` sorted ahead of `trg_enforce_outstanding_total_repayment` and `trg_enforce_rent_request_formula`. It
compared `amount_repaid` against the **old, larger** total and let it through. Any downward resize could do the same.

## Fix

- The trigger was renamed to `zz_clamp_rent_request_amount_repaid`, so it now runs after every trigger that sets the
  total or the balance. Only `zz_gate_repaying_…`, which touches status alone, sorts later. The function body is unchanged.
- Both plans were capped at `total_repayment`. There is **no cash behind the excess**, so this is not a refund. It's what
  the clamp would have done had it run last. No ledger posting. There are two `audit_logs` rows, `plan_overpaid_capped`.
- Test: a resize to 500,000 inside a rolled-back block recalculated the total to 597,223 and capped
  `amount_repaid` to 597,223. The plan was confirmed unchanged afterwards.

The monitor check now reads 0.

## Open

Kalule's plans reached "completed" largely through James Katongole's manual balance jumps (e.g. 77,223 → 1,747,223
on 11 Sep). The monitor's `plan_balance_unbacked` info check tracks that. It's not part of this fix.
