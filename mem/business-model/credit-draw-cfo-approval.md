---
name: Credit Draw CFO Approval Gate
description: Credit Access Draws no longer auto-credit the wallet; they submit to the CFO (Business Advance area) as pending_cfo and require manual edit + approval before disbursement
type: feature
---
# Credit Draw → CFO Manual Approval

`process-credit-draw` NO LONGER credits the wallet or posts a ledger entry. It creates the
`credit_access_draws` row as `status='pending_cfo'` (sets `requested_amount`, `submitted_at`,
provisional `expires_at`) and notifies CFO/managers. No treasury guard at submission (no money moves).
It blocks new submissions when the user already has an `active`/`overdue`/`pending_cfo` draw.

`cfo-approve-credit-draw` (CFO/manager/super_admin only) handles the second leg:
- `action:'approve'` — applies CFO edits (amount, duration_months 1-12), re-validates against
  `credit_access_limits.total_limit`, recomputes access_fee/total_payable/daily_charge/expires_at,
  sets `status='active'` + `started_at`, records `cfo_approved_by/at/notes`, then posts the balanced
  ledger transaction crediting the user's **withdrawable** wallet (`recipient_type:'user'`,
  `wallet_bucket:'withdrawable'`, category `wallet_deposit`). Treasury guard ('credit') runs first.
- `action:'reject'` — `status='rejected'` + `rejection_reason`.

UI: `CreditDrawApprovalQueue` renders inside `DirectCreditTool` Business Advance panel (above
`BusinessAdvanceDisbursementQueue`). User-facing `CreditAccessDrawSheet` now says "Submitted for
Approval" instead of "Credited to your wallet".

This closes the Derrick Dalaa exposure: a draw could previously be created AND auto-credited
(though unrouted), letting users file withdrawals against borrowed credit. Now no credit reaches a
wallet without explicit CFO approval.
