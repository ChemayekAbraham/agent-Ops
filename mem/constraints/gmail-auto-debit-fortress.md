---
name: Gmail auto-debit fortress
description: Four-rule permanent fix that prevents phantom CFO debit obligations from Gmail-poll phone-match engine
type: constraint
---
The Gmail poll `tryAutoDebitPayout` engine now gates every debit through
four independent rules; violating any one skips the debit. The DB is the
ultimate authority — code changes alone cannot re-open the phantom path.

- **Rule 1 (skip list)**: `ledger_reconciled_tids` — any TID present skips.
  Populated automatically by triggers on `agent_float_funding.float_delivery_tid`
  and `float_requests.float_delivery_tid`. CFO stamps the outbound MoMo TID
  at approval time.
- **Rule 2 (merchant-agent block)**: DB trigger
  `trg_block_merchant_agent_auto_debit` on `general_ledger` refuses any
  `production` wallet cash_out whose description contains `Auto-debit (phone
  match)` / `Auto-debit (name match)` when target is in `cashout_agents`
  (is_active=true). Helper `is_merchant_agent(uuid)`.
- **Rule 3 (whitelist / emergency stop)**: table
  `welile_payout_source_accounts` must contain at least one `is_active=true`
  row for the engine to run at all. Empty (default) = engine off.
- **Rule 4 (payout-intent required)**: engine requires a matching
  `withdrawal_requests.fin_ops_reference` OR
  `landlord_payouts.external_reference / finops_momo_reference` to equal the
  email TID. No intent → no debit.

Obligation status `voided_phantom` is reserved for reversals produced by
`reverse_phantom_auto_debit_obligation(uuid)` and its bulk wrapper
`reverse_all_phantom_auto_debits()`. 2026-07-15 initial run reversed 268
obligations totalling UGX 73,749,439.