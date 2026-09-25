# Speed up CFO cash movement

## Plan
1. Move the Company → Wallets and Wallets → Company calculations into one read-only database summary, preserving the current category rules and exact totals.
2. Load that compact summary first instead of downloading every ledger entry.
3. Fetch individual transaction rows only when the CFO opens a detailed transaction view or export.
4. Compare the summary against the current ledger-derived totals, test the live dashboard, and run the project safety checks.

No money or ledger records will change.

## Technical details
- Keep Kampala date boundaries and the current production/legacy reporting rules.
- Keep the same cards, filters, comparisons, totals, counts, and drill-down behavior.
- Return grouped totals and top recipients/sources from the database; paginate raw details on demand.
