---
name: Advance recovery isolation
description: Advance repayment can only debit withdrawable; float is DB-blocked; cron + deposit sweep read get_user_available_balance and emit repayment_* events
type: feature
---
Wallet Routing v2 enforcement for agent advance recovery (2026-05-13):

- `assert_routing_compatible` now blocks `agent_repayment`, `agent_advance_repayment`, `salary_advance_repayment`, and `debt_recovery` from `recipient_type='operational_wallet'`. Float-bucket recovery raises `INVALID_ROUTING` (check_violation) and is logged to `wallet_routing_violations`.
- `process-agent-advance-deductions` cron reads `get_user_available_balance(agent_id)` (NEVER `wallets.balance`); caps deduction at `min(withdrawable, outstanding_after_interest)`; on zero-withdrawable writes a `none` ledger row and emits `repayment_skipped_insufficient_balance`. Successful deductions emit `repayment_attempted` + `repayment_successful`; failures emit `repayment_failed`. Both ledger legs carry explicit `recipient_type` ('user' on wallet leg, 'operational_wallet' on platform leg) and `metadata.bucket_intent='advance_balance_recovery'`.
- `approve-wallet-operation` deposit sweep does the same: reads `get_user_available_balance` for the budget cap and tags both `agent_repayment` legs with explicit recipient_type + metadata.
- No new tables/columns. Audit flows through `system_events` and `wallet_routing_violations`.
- Test: `src/__tests__/advanceRepaymentIsolation.integration.test.ts` + `advance_repayment_isolation.sql` exercises the routing guard.
