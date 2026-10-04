# Float Transaction Visibility — Show Paid User (2026-08-15)

## Problem
In Financial Operations → Merchant float statement, every outflow read only
`Float used — customer payout` / `Company float used to settle customer cash-out <uuid>`.
The operator could not tell who received the money without opening another screen.

## What was done (UI/traceability only)
1. `src/hooks/useMerchantFloat.ts` — `useMerchantFloatStatement` now resolves the paid
   customer for float settlement legs:
   `general_ledger` leg → UUID extracted from `reference_id`/`description`
   → `withdrawal_requests.id` → `withdrawal_requests.user_id` → `profiles.full_name`.
   Resolution is batched: one `withdrawal_requests` query and one `profiles` query per
   statement load (no N+1, no per-row round trips). New read-only row fields:
   `payeeName`, `payeeId`, `payoutRequestId`.
2. `src/components/financial-ops/MerchantFloatStatementDialog.tsx` — customer payout rows
   now render the hierarchy:
   - `Float used — customer payout`
   - `Paid to <Customer name>` (or `Paid to Unknown customer` when unresolved)
   - `Company float used to settle customer cash-out …`
   - `Transaction: <withdrawal request id>`
   - amount and existing timestamp / running balance unchanged.
   The exported PDF description carries the same `Paid to …` prefix.
   Telecom sending-charge legs are unchanged (they are not a customer payout).

## Guarantees
- No ledger amounts, directions, categories, classifications, wallet buckets or float
  calculations were touched. No migration, no backfill, no sweep.
- Names are never inferred or hardcoded; unresolved rows show `Unknown customer` and keep
  the transaction id for investigation.
- The merchant agent's own name is never shown as the recipient — the recipient comes from
  `withdrawal_requests.user_id`, the agent from the ledger leg's `user_id`.
- Works for historical and future legs alike, since resolution happens at read time.

## Verification on real data
- 7,668 `agent_float_settlement` float legs: 7,667 contain a payout UUID, 7,665 match a
  withdrawal request, 7,656 resolve to a named profile (~99.8%). The rest fall back to
  `Unknown customer`.
- Spot check of the five most recent payout legs — agent vs recipient are distinct people:
  | Agent | Amount | Paid to |
  |---|---|---|
  | Mudumba samuel | 10,356 | Watsala Enock |
  | NAMULINDWA IMMECULATE | 10,000 | Catherine Nabaggala |
  | Mudumba samuel | 6,000 | Muwanguzi Fred |
  | Tugabirwe Apophia | 50,000 | Shafiq Senabulya |
  | NAMULINDWA IMMECULATE | 235,000 | Sky Bubbles |
