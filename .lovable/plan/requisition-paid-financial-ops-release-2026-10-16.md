# Requisition Paid = Financial Ops Release

## What changes

Today, the wallet credit fires automatically on the final approval (CFO for staff requisitions, CFO for employee, director for director requisitions). After this change, final approval sets the requisition to **approved** but does **not** credit the wallet. A Financial Ops user must then click **Release to Wallet** on the Approved Requisitions panel to actually move the money.

## Edge functions (3 changes)

### 1. `staff-requisition-decide/index.ts`
On final-stage approval, stop calling `creditRequisitionWallet()`. Just set `stage = 'approved'` and return success. Remove the rollback-on-credit-failure logic (there is no credit to fail). Keep the growth-claim release and system event.

### 2. `requisition-decide/index.ts` (employee requisitions)
Same: on `approve`, set `status = 'approved'` without calling `creditRequisitionWallet()`. Remove the rollback and `status = 'paid'` write.

### 3. `director-requisition-action/index.ts`
Same: on `approve`, skip the `creditRequisitionWallet()` call.

### 4. `requisition-credit-retry/index.ts` (no structural change)
Already works as the release mechanism. Expand `ALLOWED_ROLES` to include `financial_ops`. This function becomes the explicit "Release to Wallet" action.

## UI (1 file)

### `ApprovedRequisitionsPayoutPanel.tsx`
- Add a **Release to Wallet** button on each `pending` row, visible to `financial_ops`, `cfo`, `super_admin`, `manager`, and `ceo`.
- The button calls `requisition-credit-retry` (same as the existing Retry button on the staff queue).
- Update the description text: "Pending until Financial Operations releases the money" (already says this).
- Keep the existing Reverse button for paid items.

## What does NOT change
- The `_shared/requisitionWalletCredit.ts` engine (still the sole credit path).
- The `requisition-reverse` function.
- The six-eyes approval chain and database guards.
- The RPC `cfo_approved_requisitions` (already derives status from `requisition_wallet_credits`).
- Ledger posting, double-entry, notifications on credit.

## Technical details
- `requisition-credit-retry` already validates the requisition is approved and the user has no prior credit. It is fully idempotent. Adding `financial_ops` to its role gate is the only server change needed for the release action.
- The staff requisition queue's existing "Retry" button (for failed credits) stays and works the same way.
- All three edge functions must be deployed after changes.
