# Confirm the budget Submit button end to end

Run one live test that fills the budget form in completely and submits it, so we can see the whole path work rather than only reading the code.

## What the test does

1. Open the budget submission form as the signed-in user in the running app.
2. Pick a department in the open 5-day cycle that has no submission yet.
3. Fill in every required field: title `LIVE TEST - submit confirmation (please reject)`, purpose, and one item with a description, quantity 1, unit cost UGX 1,000 and a justification.
4. Click **Submit for review** and record what happens: the confirmation message, the new reference number, and the status the budget lands in.
5. Also click the button once with the title deliberately blank first, to confirm it now says what is missing instead of appearing frozen.

## What it creates

One real budget of UGX 1,000, titled so it is obviously a test and asking to be rejected. It cannot be deleted — budgets are never removed by design — so it stays in the CFO review list until the CFO rejects it.

## What it will not touch

No changes to budget amounts, approvals, wallets, the ledger, access rules, or any other department's submissions. No code changes unless the test actually fails, in which case I report the failure and propose the fix before changing anything.

## Report back

The reference number and status of the test budget, the exact confirmation message, the missing-field message, and a plain yes or no on whether all 8 department heads can now submit.
