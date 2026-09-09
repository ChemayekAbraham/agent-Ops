# Plan: Replace budget cycle period options with a 5-day period

## Goal
In the CFO "Open a new budget cycle" form, the Period type dropdown currently offers monthly / quarterly / yearly. Replace all three with a single "5days" period option.

## Changes
1. **`src/components/cfo/BudgetApprovalPanel.tsx`** (CycleManager):
   - Change the Period type options from `['monthly', 'quarterly', 'yearly']` to `['5days']` so only "5days" appears.
   - Change the default `periodType` state from `'yearly'` to `'5days'` so the field is preselected.
   - No other form fields, validation, or cycle-management behavior change.

2. **Backend check (only if needed):**
   - Verify the live `budget_create_cycle` RPC accepts `p_period_type = '5days'`. If it restricts allowed values, update the function to accept `5days` (minimal change, no other logic touched).

## Outcome
Opening a new budget cycle offers only the 5-day period, preselected by default. Existing cycles are untouched.
