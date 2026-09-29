# Correct four-part split reconciliation only

## Scope
- Add one unapplied database migration that changes only `instalment_allocations.access_split_reconciles`.
- Keep the existing null-state rule unchanged.
- Change the populated-row equality from:
  - `Returns + Agent Commission + Platform Fee = Access Fee`
  - to `Returns + Agent Commission + Platform Fee = Access Fee + Registration Fee`.
- Do not edit the four-part calculation, its amounts, repayment paths, wallets, landlord obligations, pricing, or the staged A22/A5 Principal work.

## Private verification
- Add a rollback-only SQL regression test using temporary fixture rows so no test data survives.
- Confirm the approved cumulative UGX 7,000 example remains exactly:
  - Principal: UGX 5,012
  - Partner Returns: UGX 752
  - Agent Commission: UGX 700
  - Platform Fee: UGX 536
- Confirm the corrected constraint accepts the row because `752 + 700 + 536 = Access Fee + Registration Fee = UGX 1,988`, while all four parts still total UGX 7,000.
- Cover partial and decimal repayments, same-source retry/idempotency, reversal, cancelled Rent Plans, self-support, and pool-funded cases. These tests will assert that the validation change does not alter their existing branching or amounts.

## Safety checks
- Verify the migration contains only a constraint replacement and no data updates or financial posting.
- Run the rollback-only private checks and `npm run guard:all`.
- Leave the migration unapplied and do not publish or deploy anything.
