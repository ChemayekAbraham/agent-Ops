# Buy merchandise with a zero wallet balance

Today an agent can only order merchandise if their wallet has money: "Buy now" needs the full price, and "Pay in installments" still needs enough for a first 25% charge — an empty wallet is rejected outright. This change lets anyone place an installment order regardless of balance, and the existing 25% wallet recovery collects the whole price over time as earnings arrive.

## What changes for the user

- Installments become available at any balance, including UGX 0.
- If the wallet has something, the same first 25% is taken immediately (capped by what is actually available).
- If the wallet is empty (or below the 25% figure), nothing is debited at checkout; the full price becomes the outstanding balance.
- The confirm screen states plainly: "Due now: UGX 0 — the full amount is recovered from your wallet at 25% per recovery run."
- "Buy now" keeps requiring the full amount in the wallet (unchanged); the empty-wallet warning becomes an informational note instead of a blocker for installments.
- CMO merchandise view is unchanged in shape: the order appears as a credit sale with a 25% recovery plan, so the company still sees who owes what.

## Technical detail

1. `agent_purchase_merchandise` (database function), installment branch only:
   - Remove the `v_down <= 0` rejection; allow a zero down payment (`v_down := LEAST(v_avail, GREATEST(round(v_total * 0.25), 1))`, clamped at `>= 0`).
   - When `v_down = 0`, skip the wallet debit / ledger posting entirely and insert the sale with `amount_paid = 0`, `amount_outstanding = v_total`, `payment_status = 'credit'` (instead of `partial`), `payment_plan = 'installment'`.
   - `full` mode keeps its existing `INSUFFICIENT_BALANCE` guard untouched.
2. `create_merchandise_recovery_plan` trigger already fires whenever `amount_outstanding > 0` and picks `daily_rate = 0.25` for installment sales, so a zero-down order automatically gets a plan — no trigger change needed.
3. `recover_merchandise_from_wallets` (4x/day cron) already deducts `least(outstanding, available, round(available * rate))` from the strict withdrawable balance, so zero-balance plans simply collect nothing until money lands. No change.
4. `src/pages/MerchandiseStore.tsx` (presentation only):
   - `insufficient` no longer includes the `firstInstallment <= 0` case; installments never disable the confirm button.
   - Confirm screen and installment copy handle the `dueNow === 0` case ("Nothing is taken now").
   - Keep the client-side `INSUFFICIENT_BALANCE` toast for `full` mode only.

Smartphone and Spiro bike order dialogs keep their existing balance rules — this change is scoped to catalog merchandise.