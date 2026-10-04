---
name: Advance arrears credit-time recovery
description: Missed agent advance daily repayments (arrears) are auto-clawed from the NEXT incoming earning before it becomes withdrawable, via a general_ledger insert trigger
type: feature
---
**Problem solved.** Agents withdrew commission before daily advance deductions ran,
dodging repayment. Now missed daily repayments are recovered instantly from the very
next earning, closing the withdrawal window.

**Arrears tracking (`agent_advances`).**
- `arrears_balance` — accumulated missed scheduled daily repayments; a BEFORE INSERT/UPDATE
  trigger `trg_cap_advance_arrears` keeps it in `[0, outstanding_balance]` and zeroes it
  when the advance completes (self-heals after sweep/cron/manual writes).
- `daily_installment` — scheduled fixed daily amount = round((principal+access_fee)/cycle_days).
- Seeded on rollout: arrears = scheduled-to-date − already-paid, capped at outstanding
  (overdue advances → full outstanding becomes recoverable).

**Credit-time interception.** AFTER INSERT trigger `trg_recover_advance_arrears_on_earning`
on `general_ledger` fires when a wallet-scope, cash_in, withdrawable-bound earning
(`agent_commission_earned` / `agent_commission`) posts for an agent who has
`arrears_balance > 0`. It calls `recover_agent_arrears_from_credit(agent_id, amount, ledger_id)`
(SECURITY DEFINER, service_role only). Recovery failure is swallowed — it must NEVER block
the agent's earning from posting.

**`recover_agent_arrears_from_credit`.**
- Budget = `LEAST(credit_amount, get_user_available_balance(agent))` — STRICT withdrawable
  only; never `wallets.balance`; float/commission custody untouched. Even a partial
  (earning < arrears) is captured.
- FIFO across advances (oldest `issued_at`). Per advance takes
  `LEAST(budget, arrears_balance, outstanding_balance)` and posts a balanced
  `agent_repayment` recovery via `create_ledger_transaction` with Wallet Routing v2 tags
  (wallet leg `recipient_type='user'`, platform leg `operational_wallet`,
  `metadata.source='arrears_credit_intercept'`, `bucket_intent='advance_balance_recovery'`).
  Updates outstanding/arrears/status/access-fee, writes `agent_advance_ledger` (interest 0).
- On total recovered > 0: inserts a `notifications` row (type `advance_arrears`) telling the
  agent exactly how much was deducted and why.

**Daily cron accrues arrears.** `process-agent-advance-deductions` now updates
`arrears_balance`: if today's deduction ≥ scheduled installment, surplus pays arrears down;
if it misses, the shortfall grows arrears; always capped at outstanding.

**Gotchas (verified 2026-07-10).**
- `system_events` has NO `payload` column — use `metadata` (jsonb). Its enum + FK to
  auth.users can still reject; wrap inserts in swallow blocks. The ledger + agent_advance_ledger
  are the audit trail of record.
- `notifications` inserts are gated by `block_all_notification_inserts` (allowlist by `type`).
  `advance_arrears` was ADDED to the allowlist so agents actually receive the message; the
  `AgentNotificationBell` styles this type.
- `general_ledger` has no `metadata` column — the `metadata` key in `create_ledger_transaction`
  entries is dropped (same as the sweep); don't filter ledger rows by metadata.

**UI.** Arrears shown on `AgentMyAdvancesCard` (agent) and `AgentAdvancesOutstandingPanel` (CFO).
