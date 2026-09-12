# Cash Deposit Code Delivery Indicator

## Goal
Show Financial Ops whether each cash-deposit verification code was delivered by SMS, email, both channels, or neither.

## Implementation
- Extend the existing role-protected `fin_ops_recent_cash_codes` read RPC to return the latest `code_issued` or `code_reissued` delivery metadata for each verification.
- Add a new scoped database migration only for this RPC return shape; do not change tables, policies, wallet logic, ledger logic, or deposit verification behavior.
- Update the Cash Deposit Codes panel row type to consume the returned delivery channel.
- Add a compact delivery badge to each list row and the opened details view:
  - `Delivered by SMS`
  - `Delivered by email`
  - `Delivered by SMS & email`
  - `Delivery failed` / `Available in panel` when neither provider accepted delivery
- Keep resend actions, code verification, banking controls, filters, and refresh behavior unchanged.

## Validation
- Verify current production function/table shapes before applying the migration.
- Run the project guards and targeted type/build checks.
- Confirm the panel renders the correct badge for each delivery metadata variant.
