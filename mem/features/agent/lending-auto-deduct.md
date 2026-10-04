---
name: Lending Agent auto-deduction
description: Scheduled borrower→lender wallet auto-repayment for lending_agent_loans (daily/weekly/monthly/once/end_of_month)
type: feature
---
Lending agent loans (`lending_agent_loans`) support automatic repayment collection from the borrower's withdrawable wallet into the lending agent's withdrawable wallet.

- New columns: `repayment_frequency` (daily|weekly|monthly|once|end_of_month), `auto_deduct_enabled`, `installment_ugx`, `next_deduction_date`, `auto_deduct_started_at`, `last_auto_deduct_at`, `auto_deduct_attempts`, `auto_deduct_collected_ugx`.
- Installment basis: total owed (principal + interest) split evenly across the periods in the loan window. Helpers `buildSchedule`/`periodsFor`/`firstDeductionDate` in `lendingHelpers.ts`.
- Edge function `lending-auto-deduct`: daily cron (`lending-auto-deduct-daily`, 06:00 UTC, job 77). Sweeps due+open+auto loans, takes-what's-available (partial OK, retries next cycle), moves money via `create_ledger_transaction` category `wallet_transfer` recipient_type `user` (so it lands in withdrawable). Accepts optional `{ loan_id }` to run one loan immediately. Idempotency key `LAD-<loan8>-<yyyymmdd>`.
- UI: disburse form has auto-deduct toggle + schedule select (default ON, monthly); approved loan requests auto-enable (monthly, or once if duration<=1d). Borrower card shows an "Auto <freq> · ~amount · next date" chip.
