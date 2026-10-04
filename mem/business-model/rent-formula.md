---
name: Welile Rent Repayment Formula
description: Single-source-of-truth rent pricing formula enforced by DB trigger; client values are ignored
type: feature
---

## Formula (constitution)

```
Total Repayment = (Rent × 1.33^n) + Registration Fee   where n = days/30
Registration Fee = 10,000 if Rent ≤ 200,000 else 20,000
Daily Payment   = ceil(Total Repayment / Days)
```

## Enforcement

1. **DB function** `compute_rent_repayment(rent, days)` — IMMUTABLE source of truth. Returns `(access_fee, request_fee, total_repayment, daily_repayment)`.
2. **DB trigger** `trg_enforce_rent_request_formula` (BEFORE INSERT/UPDATE on `rent_requests`) — silently overwrites the four fee fields with canonical values. Client-supplied values for these fields are ignored.
3. **TS implementation** `src/lib/rentCalculations.ts::calculateRentRepayment` — must match the DB function. Locked by `src/lib/__tests__/rentCalculations.test.ts` (24-row reference table).
4. **Drift view** `rent_request_formula_drift` — read-only; lists historical rows that diverge from the formula. CFO reviews before any one-shot backfill.

## Edge function rules

- `submit-tenant-form`: pass `0` for the four fee fields; trigger fills them in.
- `approve-rent-request`: re-derives via `compute_rent_repayment` RPC for legacy safety.
- `validate-payload`: the four fee fields are marked `derived: true` and skipped by the validator.

## Reference table (commission base)

| Rent (UGX) | 30d total | 60d total | 90d total |
|---|---|---|---|
| 50,000  | 76,500   | 98,445  | 127,632   |
| 100,000 | 143,000  | 186,890 | 245,264   |
| 200,000 | 276,000  | 363,780 | 480,527   |
| 250,000 | 462,225  | 462,225 | 608,159   |
| 500,000 | 685,000  | 904,450 | 1,196,319 |

Agent commission = 10% of `total_repayment` collected, paid as repayments come in.