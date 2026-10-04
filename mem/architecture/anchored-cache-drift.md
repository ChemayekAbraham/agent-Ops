---
name: Anchored cache drift + reseed (both directions)
description: Diagnostics + RPCs to bring cached wallet buckets back to the ledger-true figure when they drift in EITHER direction
type: feature
---
Anchored wallets can drift two ways relative to the ledger sum:

**Over-cache (withdrawable above strict)** — promised money the system will refuse at withdrawal time.
- Diagnostic: `wallet_anchored_drift_view` (`over_cache_delta`).
- Surface: CFO **Reconciliation** tab → `<AnchoredCacheDriftPanel />`.
- Fix: `reseed_anchored_withdrawable(p_user_id, p_reason)` — CFO/super_admin only, reason ≥ 10 chars. Posts wallet `system_balance_correction` cash_out + platform `phantom_writedown_clearing` cash_in via `create_ledger_transaction`, driving the cache down through the sole-writer path. Logs to `wallet_historical_drift_review` (`status=reseed_posted`).
- UI clamps: CFO Wallet Deduction "By Balance Range" list clamps each row to `get_user_available_balance` and warns when cache > strict.

**Under-cache (`wallets.balance` below ledger sum)** — agent has float on the ledger but the cache stops them spending it. Symptom: `wallets_balance_check` constraint failure during `agent_allocate_tenant_payment` and similar flows.
- Diagnostic: `wallet_anchored_balance_drift_view` (`understated_by`). CFO/super_admin only via security_invoker view.
- Fix: `reseed_anchored_balance(p_user_id, p_reason)` — CFO/super_admin only, reason ≥ 10 chars. Posts wallet `system_balance_correction` cash_in (with `recipient_type='user'`) + platform `phantom_writedown_clearing` cash_out, raising the cache to ledger.
- Auto self-heal: `agent_allocate_tenant_payment` calls the same correction in-place when it detects `ledger_total > cached_balance` before the float gate, so agents are not blocked at the till. The response includes `self_heal_applied` + `self_heal_amount` for observability.

**Commission ledger guard**: `agent_allocate_tenant_payment` now treats `commission_raw < 0` as a hard error (`error_code: 'COMMISSION_LEDGER_INCONSISTENT'`) and logs to `wallet_commission_drift` instead of silently clamping to 0. Previously the clamp let agents allocate against fake float and the trigger was the only thing catching it.

**Frontend mapping**: `humanizeAllocationError` in `AgentTenantCollectDialog.tsx` translates `wallets_balance_check` and `COMMISSION_LEDGER_INCONSISTENT` into actionable messages — never show raw Postgres constraint text to agents.
