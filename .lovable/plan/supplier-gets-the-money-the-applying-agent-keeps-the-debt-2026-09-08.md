# Supplier gets the money, the applying agent keeps the debt

## What I checked first

- The disbursement step (`cfo_disburse_smartphone_order`, verified against the live database, not just the migration file) already pays the **supplier's wallet**: the down payment is credited to the supplier as withdrawable money, and the company records the matching cost. So "deposit the down payment on the supplier's wallet" is already how it works — no change needed there.
- The order row itself already stays attached to the applying agent (the agent is the customer on the order, and the amount to recover plus the daily amount are stored on that order).

## The real gap I found

The repayment plan that drives the daily wallet deduction is only created **at the moment the application is first submitted**, and at that moment the amount to recover is still zero — so the plan is skipped and never created afterwards.

Confirmed in live data: every smartphone application on record has **no active repayment plan**, and no smartphone application has been disbursed yet. Meaning if a phone were released today, the supplier would be paid and **nobody would ever be charged the daily repayment**.

## What to change

1. **Create the agent's repayment plan at disbursement.**
   Inside the existing disbursement step, after the supplier is paid, create (or refresh, if one somehow exists) the repayment plan for that order with:
   - the person responsible = the **applying agent**, never the supplier;
   - amount to recover = the total repayable already computed on the order;
   - daily amount = the daily amount already computed on the order;
   - start date = the existing 14-day grace date already stored on the order.
   Written to be safe to run twice, so a repeated disbursement attempt cannot create two plans or double the debt.

2. **Guard against ever billing the supplier.**
   In the same step, refuse to proceed if the supplier and the applying agent are the same person, and always take the responsible person from the application's agent field.

3. **No change to any amount or rule.**
   Down payment value, the internal charge, the daily figure, the grace period, the approval chain (Agent Ops → COO → CFO), the pickup verification gate, and the existing daily recovery job all stay exactly as they are. The daily recovery job already charges the person named on the plan, so once the plan exists it will collect from the agent's wallet/commission automatically.

4. **Small wording addition (screens only).**
   On the Agent Ops application details and on the agent's own order card, state plainly: down payment paid to *supplier name*; repayment owed by *agent name*. This removes any doubt about who owes what, and adds no new figures.

## Technical notes

- One database change: replace the body of `public.cfo_disburse_smartphone_order` so it also upserts the `merchandise_recovery_plans` row for `merchandise_sales.customer_id` (sale-scoped, idempotent, with `daily_deduction_amount`, `outstanding_balance = total_repayable`, `starts_on = repayment_starts_on`). No new tables, no schema change, no change to the ledger legs it already posts, no change to `recover_merchandise_from_wallets`.
- The existing `trg_create_merchandise_recovery_plan` after-insert trigger stays untouched (it still serves other merchandise paths); the smartphone path simply stops depending on it.
- Frontend: copy-only edits in `SmartphoneOrderApprovalQueue.tsx` and `SmartphoneOrderStatus.tsx`.

## Out of scope

No historical backfill (nothing has been disbursed, so there is nothing to repair), no change to Mo Banja's own weekly collection (still off-platform), no phone-lock workflow.
