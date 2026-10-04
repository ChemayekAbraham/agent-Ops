# Clarify Balance Sheet Breakdown Sources

## What will change
- Keep the existing tap-to-open breakdown modal for every asset, liability, and shareholders’ equity line.
- Add a clear **Value source** beneath each component and ledger account, using the source already returned with the balance-sheet figures.
- For subtotal and total modals, expand each contributing group to show its underlying account lines and their sources, rather than showing category names alone.
- Explain when a figure is calculated from several displayed lines or is held outside the ledger.

## Technical details
- Update only `src/components/cfo/BalanceSheetPanel.tsx`.
- Reuse the existing statement response and classification groups; no accounting calculations, records, functions, policies, or migrations change.
- Preserve UGX formatting and ensure the displayed contributors still reconcile to the selected balance.
- Verify the modal in the CFO Statements view and run the existing safeguards.
