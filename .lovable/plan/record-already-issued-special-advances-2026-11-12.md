# Record already-issued Special Advances

## What the CFO gets
- A separate **Record already-issued advance** action beside the existing new-advance action.
- Capture the borrower, agreed terms, original payment date, method, transaction reference and receipt evidence.
- Confirm the money was paid outside Welile and has not previously been entered in Welile's accounts.
- Save as already paid, with repayments scheduled from the original payment date. Show it in Agreements and existing repayment/reporting screens.
- Never credit a wallet, initiate a transfer or disburse again. Existing new advances remain unchanged.

## Safety
- Enabled CFO access, existing borrower checks and append-only audit.
- Reject future payment dates, missing proof and duplicate transaction references; repeated saves return the same record.
- Record the original external payment in existing Special Advances accounting categories once, since it is not yet in Welile's accounts.
- No merchandise storage or unrelated financial changes.

## Technical details
- Add a dedicated historical-recording RPC and quote support through the approved migration workflow after verifying live columns, triggers and helpers. Do not weaken existing create/disburse date checks.
- Reuse server calculation, proof validation, ledger posting and statement helpers. Write agreement, schedule, original-payment accounting and audit atomically, without wallet legs or payout execution.
- Reuse the Special Advance form and private proof-upload pattern in historical mode; read successful recording back through Agreements and the detail statement.
- Test original-date scheduling, no wallet credit or payout call, CFO authorization, duplicate/replay prevention and unchanged new-advance behavior. Run focused tests, guards and confirm the automatic build.

## Already completed
Agent Ops signage region filtering and location search are saved in `18dca94cc1`; 12 tests pass and build is clean.

## Existing hold
Welile Schools fees plans remain shelved; its button and gate registration tool remain unchanged.
