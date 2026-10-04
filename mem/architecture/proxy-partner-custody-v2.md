---
name: Proxy Partner Custody v2
description: Cutoff-only refactor — proxy partner ROI/withdrawals must credit/debit the PARTNER directly; agent only initiates; FinOps approves all
type: feature
---
**Cutoff:** stored in `system_config.proxy_custody_cutoff_at` (set on 2026-05-12 deploy).

**New rules (post-cutoff):**
- Partner ROI credits go to `partner.user_id` (recipient_type='user' → withdrawable). NEVER to the agent with `linked_party=partner_id`.
- Proxy withdrawals: insert `withdrawal_requests` with `user_id=partner_id`, `agent_id=initiated_by=agent_id`, `beneficiary_id=partner_id`, `proxy_partner_id=partner_id`, `auto_dispatched=false`, NO `linked_party`. The strict view auto-deducts partner.withdrawable as a hold.
- BOTH proxy-withdrawal entry points must follow this shape:
  - `AgentProxyWithdrawalDialog` (FunderDetailView)
  - `WithdrawRequestDialog` when invoked with `linkedParty` prop (ProxyPartnerFunds)
  Neither may set `linked_party` on a NEW row, and neither may overwrite the agent's saved MoMo profile on a proxy submission.
- `trg_block_proxy_custody_writes` on `general_ledger` raises `PROXY_CUSTODY_BLOCKED` for any post-cutoff wallet-scope insert where `linked_party` is a supporter and `user_id` ≠ supporter. Bypass only via session GUC `wallet.legacy_proxy_reversal=true` for legacy reversal paths.
- `trg_force_proxy_finops_visibility` forces `auto_dispatched=false` whenever `initiated_by IS NOT NULL AND initiated_by <> user_id`, so every proxy withdrawal lands in FinOps pending.
- `agent-withdrawal` edge fn rejects any target where the recipient holds the `supporter` role (HTTP 403, `code: use_initiate_proxy_withdrawal`).

**Legacy (pre-cutoff):** existing 245M parked in agent wallets and 850M overdrafts stay where they are. They drain through the existing `approve-withdrawal` `linked_party` branch. No backfill, no sweep.

**Cron:** `process-supporter-roi` remains paused. CFO continues manual `cfo-direct-credit` to the partner directly (`recipient_type='user'`, category `roi_wallet_credit` — already locked by USER_OWNED_CATEGORIES guard).
