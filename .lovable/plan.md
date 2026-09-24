# Lending-agent daily repayment repair

## Outcome
- Keep every missed scheduled installment overdue instead of silently moving it to a future date.
- On each daily run, recover the oldest unpaid scheduled amount first, using only the borrower’s strict available wallet balance.
- Notify every borrower with an overdue lending-agent advance in-app and by email, listing all overdue dates.
- After a successful recovery, notify the borrower of the amount recovered, remaining balance, and that consistent funded-wallet repayments can improve eligibility for access up to **UGX 30,000,000**. This will be eligibility wording, not a guaranteed increase.
- Apply the behavior to all current and future lending-agent advances, including Benjamin Muhanguzi’s advance to Kamulinde Cosea Enock.

## Implementation
1. Update the existing daily repayment function so schedule progress is based on cumulative amount recovered, not merely the last attempted date.
2. Derive overdue dates from each advance’s stored cadence and schedule, preserving partial installments and retrying arrears daily.
3. Keep every debit inside the existing security-controlled ledger transaction, with a date-specific idempotency key and no direct wallet edits.
4. Add best-effort, deduplicated in-app alerts for overdue and successful recoveries; notification failure will never roll back money movement.
5. Add a branded app-email template and send one deduplicated email per advance/day through the existing email queue.
6. Use `kamulindecoseaenock@gmail.com` for Enock’s repayment emails, as authorised, without merging or relinking the two accounts.
7. Emit repayment events with overdue-date and recovery details so audit and trust processing can consume them.

## Verification and rollout
- Test daily, weekly, monthly, one-time, partial-payment, no-funds, retry, and fully-paid cases.
- Run the full backend safety checks.
- Deploy only the updated daily repayment function and the shared email-sending function required for the new template.
- Trigger the target advance once after deployment, then verify the ledger result, advance balance, next due date, in-app alert, and queued email. No debit will exceed Enock’s strict available balance.
