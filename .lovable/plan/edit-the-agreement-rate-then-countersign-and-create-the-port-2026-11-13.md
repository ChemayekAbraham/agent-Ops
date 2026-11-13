# Edit the agreement rate, then countersign and create the portfolio

## Current problem
The rate’s Save button requires an existing portfolio, but a company-managed partner’s first portfolio is created only when the agreement is countersigned. Editing the rate therefore blocks the very step that would create the portfolio. Simply removing that block would send a contract with a rate the portfolio does not use.

## Requested flow
1. Edit and save the agreement’s monthly rate, including when the partner has no portfolio yet.
2. Complete the agreement amount, representative details, execution date and signature.
3. If the edited rate requires CFO approval, wait for approval. Do not create or fund the portfolio, countersign, or send the contract while approval is pending.
4. After approval, countersign. For company-managed support, create the portfolio at that approved rate using operational float, then store and send the matching contract.

## Changes
- Add a server-owned rate request for agreements without portfolios, using the existing rate-policy and staff-verification rules rather than treating a typed rate as approved.
- Include these requests in the CFO rate-review screen, with the partner’s name and an indication that the portfolio has not yet been created.
- Connect the agreement’s rate box to this workflow. Show pending, rejected and approved outcomes; preserve completed form details while checking approval.
- Recheck approval and the final rate before countersigning. Render the contract from confirmed terms, not an unsaved draft.
- Make portfolio creation consume the approved agreement rate atomically, retaining existing operational-float, partner-verification and duplicate-creation safeguards.
- Keep existing portfolio rate-change and next-cycle rules unchanged. Self-support continues to create no portfolio at countersign.

## Technical scope
Frontend changes alone cannot resolve this: the live countersign function currently creates portfolios at the server-selected rate and has no argument for an approved agreement-rate request. Add a narrowly scoped migration and update only the relevant agreement, rate-review and countersign code. No SMS, storage visibility, unrelated permissions or unrelated edge-function deployments.

## Verification
- Test rate saving before a portfolio exists.
- Test that pending or rejected approval prevents countersign and portfolio creation.
- Test that an approved rate is used identically in the portfolio and executed contract.
- Test that changing the rate again requires a fresh decision where the policy requires it.
- Test retries, insufficient float, existing portfolio rate changes and unchanged self-support behavior.
- Run the affected tests and repository safeguards; check the automatic build.
- Real signed-in countersign verification is unavailable with this project’s externally managed authentication. Do not create or fund a real portfolio merely to test the change.