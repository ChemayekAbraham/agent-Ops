---
name: Cash-Out Agent permission matrix
description: CFO-configurable permission matrix (payout categories, approvals, float, limits, networks, banks, security, status) per merchant/cash-out agent, stored in cashout_agents.config jsonb
type: feature
---
The CFO "Edit Cash-Out Agent" modal (`CashoutAgentManager.tsx` → `EditMerchantDialog`) is a full permission matrix, not just a channel selector. All settings persist to `cashout_agents.config` (jsonb, default `{}`).

**Sections (accordion):** General (label + region/district/branch/cluster/supervisor/team + Agent Status: active/suspended/blocked/under_review/on_leave), Payment Channels (Mobile Money → MTN/Airtel sub-toggles, Bank Transfer → per-bank sub-toggles, Cash Payout), Authorized Payout Categories (grouped, each enabled category gets an approval-rule Select), Float Permissions (request/receive/distribute/emergency + max), Transaction Limits (daily/single/monthly/max+min cash-out), Security (OTP/2FA/device restriction/high-value verification).

**Config shape + constants:** `src/lib/cashoutAgentConfig.ts` — `CashoutAgentConfig`, `defaultCashoutAgentConfig()`, `normalizeCashoutAgentConfig(raw, legacyRow)`, `PAYOUT_CATEGORY_GROUPS`, `ALL_PAYOUT_CATEGORIES`, `APPROVAL_RULES`, `AGENT_STATUSES`, `SUPPORTED_BANKS`.

**Legacy sync (important):** on save, the legacy boolean columns are kept in sync so existing routing/filters keep working — `handles_cash=channels.cash`, `handles_bank=channels.bank`, `handles_mtn=channels.momo && networks.mtn`, `handles_airtel=channels.momo && networks.airtel`, `is_active = status==='active'`. `normalizeCashoutAgentConfig` seeds channels/networks from these columns when no config was ever saved.

**Validation:** must have ≥1 channel AND ≥1 authorized category. Change audited to `audit_logs` (`cfo_merchant_agent_updated`, before/after + config).

**Category enforcement in the merchant claim queue (wired 2026-07-07):** The withdrawal claim queue (`AgentCashPayoutsTab`, backed by `withdrawal_requests`) now maps every withdrawal row to a payout category from its `reason` and only surfaces / allows claiming of the categories the agent is authorized for. Helpers live in `src/lib/cashoutAgentConfig.ts`:
- `QUEUE_CATEGORY_DEFS` — ordered defs (proxy_partner_withdrawal, landlord_payouts, roi_payments, payroll_payments, agent_commissions, wallet_withdrawals catch-all) with a client `match(row)` + PostgREST predicates. `agent_commissions` is authorized by ANY of `cashout_commission`/`rent_collection_commission`/`partner_commission`.
- `getWithdrawalQueueCategory(row)`, `isWithdrawalCategoryAuthorized(config, row)`, `authorizedQueueCategoryLabels(config)`, and `buildQueueCategoryOrClause(config)` (returns a single `.or()` clause, or `null` when all categories allowed; the wallet catch-all is expressed as `reason.is.null` OR `and(<negation of every special pattern>)`).
`applyQueueFilters` takes `categoryOrClause` and ANDs it into the queue/counts/available-total queries so pagination + badges stay accurate; `handleClaim` re-checks `isWithdrawalCategoryAuthorized` before claiming; a badge banner shows the authorized category labels.

NOTE: Enforcement across the payout EDGE FUNCTIONS (per-category approval routing, blocking settlement server-side) is still NOT wired — future step that should read `cashout_agents.config`.

**User-selected withdrawal reason (2026-07-07):** `WithdrawFlow` (details step) now has a required "Reason for withdrawal" selector driven by `WITHDRAWAL_REASON_OPTIONS` in `src/lib/cashoutAgentConfig.ts` (+ an "Other" free-text, max 200 chars). The chosen reason is passed as `p_reason` to the `submit_withdrawal_request` RPC and stored on `withdrawal_requests.reason`. Its keywords are aligned with `QUEUE_CATEGORY_DEFS.match()` so the stored reason maps the row to the right payout category and reaches an authorized Cash-Out Agent (Wallet withdrawal→wallet_withdrawals, Commission payout→agent_commissions, ROI returns payout→roi_payments, Salary/payroll payout→payroll_payments).

**`process_cash_out` capability auto-sync (2026-07-10):** `can_process_cashout(agent)` = active `cashout_agents` row AND `has_agent_capability(agent,'process_cash_out')`. The CFO assign flow only inserts the `cashout_agents` row, so the capability was never granted — leaving active merchant agents with `can_process_cashout=false` (and `useAgentCapabilities().canCashOut=false`). Fixed with DB trigger `trg_sync_cashout_agent_capability` (fn `sync_cashout_agent_capability`, AFTER INSERT OR UPDATE OF is_active on `cashout_agents`): active row → grants/re-activates `process_cash_out`; `is_active=false` → revokes it. Backfilled all active merchant agents. Do NOT rely on the client to grant this capability — the trigger is the source of truth.
