---
name: Wallet Deduction RETIRED — use CFO Direct Debit
description: The wallet-deduction edge function is retired. All wallet→platform debits MUST go through CFO Direct Debit (cfo-direct-credit, operation:'debit').
type: constraint
---
**RETIRED 2026-05-08.** The `wallet-deduction` edge function and its `WalletDeductionPanel` UI are gone.

- `wallet-deduction` now returns HTTP 410 Gone — no ledger writes possible.
- `WalletDeductionPanel.tsx` has been deleted.
- The `wallet_deductions` table is preserved **read-only** for historical audit. `WalletRetractionsFeed` and `PartnerFinancialActivity` still read from it.

**Single channel for wallet → platform debits:**
`DirectCreditTool` → `cfo-direct-credit` edge function with `operation: 'debit'`. This:

1. Gates the cap on `get_user_available_balance(target_user_id)` (strict withdrawable). Never spills into float.
2. Posts a balanced double-entry to `general_ledger` (user `cash_out` + platform `cash_in`) tagged with `recipient_type: 'user'` so Wallet Routing v2 lands the deduction on `withdrawable_balance`.
3. Updates the wallet cache via `apply_wallet_movement` only.
4. **Does NOT create any debt** — no `agent_advances` insert, no `advance_balance` mutation, no debt-recovery hook. So the user's future deposits are not silently swallowed.
5. Logged in `audit_logs` as `cfo_direct_debit` and visible in `CFOActionsLog`.

**Why:** Two parallel debit paths confused operators and made it ambiguous whether a debit could create a downstream debt. Consolidating to CFO Direct Debit enforces one auditable path with no advance/debt side effects.
