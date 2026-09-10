# Verify the budget Submit for Review button end to end

Confirm the department budget submission form lets the 8 designated heads complete and submit a budget, and that the Submit for Review button responds correctly both when the form is incomplete and when it is complete.

## What the test does

1. Open the budget submission form as the signed-in user in the running app.
2. Select an open 5-day cycle and a department the user heads that has no submission yet.
3. Click Submit for Review with the title deliberately blank first, to confirm the button is not frozen and reports what is missing.
4. Fill every required field: title `LIVE TEST - submit confirmation (please reject)`, purpose, and one item with description, quantity 1, unit cost UGX 1,000, and justification.
5. Click Submit for Review again and record the result: confirmation message, reference number, and final status.

## What it creates

One real budget of UGX 1,000, titled so it is obviously a test and asking to be rejected. Budgets are never deleted by design, so the row stays in the CFO review list until rejected.

## What it will not touch

No code changes unless the test actually fails. No changes to budget amounts, approvals, wallets, the ledger, access rules, agents, or any other department's submissions. Scope is strictly the departmental budget submission form for the 8 designated heads.

## Report back

- The missing-field message shown when the form is incomplete.
- The reference number and final status after a complete submission.
- A plain yes or no on whether all 8 designated department heads can now submit.
