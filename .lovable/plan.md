# Professionalize the service revenue statement

## What will change
- Rework the selected income-statement area into a formal, single-column financial ledger.
- Add a clear report heading and consistent section labels for revenue, deductions, expenses, contribution, review items, and recognition.
- Align every UGX amount in a stable numeric column and improve spacing between detail rows, subtotals, and totals.
- Use restrained semantic treatments for positive amounts, deductions, deficits, and review warnings.
- Keep every existing figure, calculation, explanatory note, export, and drill-down unchanged.

## Technical details
- Update presentation only in `src/components/manager/FinancialStatementsPanel.tsx`.
- Reuse the current design tokens and existing shared controls; no database, accounting, or business-rule changes.
- Verify the selected statement at desktop and mobile widths, then run the existing project safeguards.
