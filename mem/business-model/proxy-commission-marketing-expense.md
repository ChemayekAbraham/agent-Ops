---
name: Proxy commission approval is a marketing expense
description: Approving a proxy agent portfolio commission (2% creation / 1% top-up) books the platform leg as marketing_expense; "Completed" records settlement with no ledger movement.
type: feature
---
Approving a proxy agent portfolio commission in Partner Ops → Proxy Agents → Commissions
(`approve_proxy_commission` → `pay_proxy_commission_queue_item`) posts a balanced pair via
`create_ledger_transaction`:

- platform leg: `cash_out`, category `marketing_expense`, description prefixed
  `Marketing expense: ...`
- wallet leg: `cash_in`, category `partner_commission`, `recipient_type='user'`,
  `linked_party = partner_id` (proxy agent's withdrawable bucket)

So in finance, every commission approval is a **marketing expense** — never a payroll,
commission-payable, or ROI cost. `system_events.metadata.expense_class = 'marketing_expense'`
carries the same classification. Reports on commission spend must read the
`marketing_expense` platform legs, not the wallet legs (which would double count).

`mark_proxy_commission_completed` ("Completed" button) is bookkeeping only: it flags the row
paid, moves no money, and posts NO ledger entry — so it must never be counted as marketing
expense.
