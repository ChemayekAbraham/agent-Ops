# Select All for Payment and Bulk Review

## What will change

- Replace the table-header “Select All” checkbox with a prominent **Select All for Payment** button above the list.
- On click, select only the currently visible requisitions that are still eligible for company payment, excluding partner-reserved or otherwise ineligible rows.
- Immediately open a bulk-payment review screen; the button will reflect the current selection count when users return to the list.
- Keep each row’s checkbox so users can still remove or add eligible tenants individually.

## Review before payment

- Show the selected tenant count and total **UGX** payout prominently.
- Show the payment destination breakdown, fees, expected repayment, batch reference, and a scrollable tenant list with individual amounts.
- Allow users to remove tenants from the review before confirming.
- Provide a clear back/cancel action that makes no changes.
- Use **Confirm & Pay Selected** as the only bulk action that invokes the existing payment function.

## Safety and compatibility

- Opening the review screen remains local selection state only: no payment request, status update, wallet change, settlement, or ledger entry.
- Re-check selected rows against the latest eligible queue immediately before confirmation so stale or newly reserved requisitions cannot be submitted.
- Keep the existing individual Review and payment flow unchanged.
- Preserve server-side authorization and the existing payment function as the final authority.

## Verification

- Verify filtered selection, excluded ineligible rows, count/total updates, row deselection, cancel/back behavior, and the review layout on desktop and mobile.
- Confirm no write requests occur when selecting or opening review.
- Run type checks, project guards, and inspect the latest preview build result.
- Do not execute the final payment action during testing.
