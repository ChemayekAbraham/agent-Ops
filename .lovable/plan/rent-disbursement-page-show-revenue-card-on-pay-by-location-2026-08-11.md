# Rent Disbursement Page — Show Revenue Card on "Pay by Location"

## Goal
When the CFO uses the existing **Pay by Location / Category** picker inside the **Fund Agent Landlord Payout Float** card, render the same **"Revenue from this disbursement"** summary card that already appears when individual tenants are selected. No payout logic, validation, or ledger behavior changes.

## Scope
- One file only: `src/components/cfo/RentDisbursementQueue.tsx`
- UI/display change only. All existing calculations (`totalRent`, `totalRevenue`, `totalRepaymentExpected`, `TreasuryImpactBanner`) are reused.

## Current state
- The revenue summary card (Rent Out / We Earn (Fees) / Total Repayment + Treasury Impact) is rendered only when `selected.size > 0`.
- The location picker sets `locationScopeIds`, which already restricts `filteredItems` to the scoped rent requests.
- `queueTotalRent` and `queueTotalRevenue` already reflect the scoped totals because `filteredItems` respects the active scope.

## Implementation
1. Compute display totals:
   - If `locationScopeIds` is active, use the scoped `filteredItems` totals for rent, fees, and total repayment.
   - Otherwise fall back to the existing selected-item totals.
2. Render the existing revenue summary card when **either** `locationScopeIds` is active **or** `selected.size > 0`, using the display totals computed in step 1.
3. Keep the existing card JSX and `TreasuryImpactBanner` invocation unchanged.
4. Add a small inline label (e.g. "Scoped by location") when the card is shown because of location scope, so the CFO knows the summary covers the whole scoped set, not just ticked rows.

## Verification
- Open CFO Dashboard → Wallet Payout → Fund Agent Landlord Payout Float.
- Use "Pay by Location / Category" to select a district/category.
- Confirm the green "Revenue from this disbursement" card appears immediately with the scoped totals.
- Confirm ticking individual rows within the scope does not duplicate the card and the totals remain consistent.
