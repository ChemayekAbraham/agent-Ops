# Merchant "Fix balance" — false success message

Date: 14 Aug 2026 · Scope: read-only investigation + UI/hook honesty fix. No wallet, ledger,
backfill or sweep operations were run. No user data was created, changed or deleted.

## Symptom

FinOps → Money with agents → "Fix balance for JOSHUA WANDA": the operator enters a type, an
amount and a reason, presses **Save fix**, gets a green "Correction recorded" toast — and the
figure they were trying to correct ("They're holding our money", board vs books gap) does not
move. It reads as a false success.

## Root cause

Two separate problems, both real.

### 1. The toast claimed success for a write that cannot affect the figure on screen

`get_merchant_float_positions()` derives its columns from different sources:

| Card in the dialog | Source |
| --- | --- |
| Money they paid out | completed `withdrawal_requests` |
| Money we paid them back | `agent_float_deposit` ledger legs **+ adjustments** |
| Fixes already made | `merchant_float_reconciliations` |
| We owe them | paid out − (float credits + adjustments) |
| **They're holding our money** | **`wallets.float_balance` only** |
| **Board vs books (gap)** | **`wallets.float_balance` vs ledger float** |

A `merchant_float_reconciliations` row only ever folds into `adjustments_total`. It is by design
display-only and can never move `company_cash_with_agent` or the board-vs-books gap. Verified
against the live desk (`b7cf4ce1…`, JOSHUA WANDA) with a read-only projection: adding a test
+UGX 100,000 `opening_balance` moves adjustments from −121,309,410 to −121,209,410 while
`company_cash_with_agent` stays at 488,410 — unchanged. So the write succeeded, the toast was
truthful about the row, and misleading about the outcome the operator expected.

The helper copy made it worse: for `opening_balance` and `write_off` it printed
"Adds to the money we already count as paid back to this agent", which is not what those types mean.

### 2. The write was reported as success without reading the row back

`usePostMerchantAdjustment` ran `.insert(...)` with no `.select()`. Any path where PostgREST
returns 2xx with zero affected rows (RLS/grant edge cases, a restrictive policy change) would
still resolve the mutation and fire the success toast. The insert policy requires
`created_by = auth.uid()` **and** cfo / financial_ops / manager / super_admin, so a non-finance
operator can hit exactly that class of outcome.

## Fix applied

- `src/hooks/useMerchantFloat.ts` — the insert now uses `.select('id, adjustment_type, amount, created_at').maybeSingle()`
  and throws when no row comes back. A dropped write can no longer surface as success.
- `src/components/financial-ops/MerchantReconcileDialog.tsx`
  - Success toast now states the actual effect ("We owe them is now X") and explicitly says
    "They're holding our money" is unchanged because it comes from the books.
  - Before saving, a "What this fix will change" preview shows the before → after for the two
    figures a fix can move, and names the two figures it cannot.
  - Per-type helper text corrected for `opening_balance` and `write_off`.

## Not changed

No migration, no RPC change, no ledger or wallet write, no backfill, no sweep. The board-vs-books
gap for any desk still has to be corrected on the books (ledger), which is the intended rule.

## Test performed

Read-only SQL projection on the live desk for JOSHUA WANDA (arithmetic only, no writes) plus a
TypeScript typecheck of both changed files. Both clean.