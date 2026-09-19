# Clear correctly mapped ledger items from review

## What will change
- Classify the seven currently flagged entries as non-profit-and-loss movements in the income statement mapping.
- Treat bank recognition and float settlement as an asset transfer, not income or expense.
- Treat equal reconciliation entries as balancing corrections, not income or expense.
- Treat treasury allocation as a deferred-fee liability movement, not revenue.
- Treat commission accrual and settlement as commission-payable liability movements, not duplicate expenses.
- Keep all existing revenue, expense, and bottom-line totals unchanged; only remove these correctly understood entries from “Flagged for review.”

## Verification
- Confirm each category resolves to the non-P&L bucket and no longer enters the review list.
- Run the project safeguards and verify the income statement in the preview.

## Technical details
- Update only the central income-statement category map in `src/lib/incomeStatementServiceMap.ts`.
- No ledger records, database functions, access policies, migrations, or money-moving logic will be changed.
