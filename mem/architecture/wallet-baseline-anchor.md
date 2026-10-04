---
name: Wallet Withdrawable Strict Rule + Fresh-Start Anchor
description: Strict ledger-backed get_user_available_balance with per-user fresh-start anchor that narrows the production ledger window
type: feature
---
`get_user_available_balance(p_user_id)` returns
`max(0, min(wallets.withdrawable_balance, max(0, wallet_ledger_net)) − pending_holds)`.

Cached wallet buckets, commission ledger sums, baseline snapshots, and `wallets.balance` can REDUCE the displayed withdrawable but can NEVER inflate it. UI (`useAgentBalances`, hero/full-screen wallet cards, WithdrawFlow) AND the `approve-withdrawal` edge function all gate on this RPC. `wallet_strict_drift_view` exposes diagnostics for the CFO.

**Fresh-Start Anchor (2026-04-29)**: when a row exists in `wallet_fresh_start_anchors` for a user, the production ledger window is narrowed to `created_at >= anchor_at`. The strict rule itself is unchanged — only the ledger sum's window is. Used to neutralize legacy negative drag (CFO retractions, float settlements, unmatched wallet_deductions) so today's earnings are visible immediately. The cache cap is preserved: an anchor never inflates withdrawable beyond what the post-anchor ledger justifies.

Backfill on 2026-04-29 anchored 34 agents whose production net was negative (~114M total drag). Their cached withdrawable (~93M phantom) was simultaneously seeded into `wallet_historical_drift_review` for explicit CFO release/writedown decisions. New agents and currently-positive agents are unaffected.

**Float bucket extension (2026-05-01)**: the same anchor now also governs the **float** bucket inside `v_user_wallet_strict` (and by extension `get_user_wallet_view`, which the agent dashboard reads). Joshua Wanda case: a real, approved 100,000 UGX `agent_float_deposit` was correctly posted to the ledger and to `wallets.float_balance`, but the strict view returned `float_balance = 0` because cumulative historical `agent_float_settlement` + `agent_float_used_for_rent` outflows (~505K) exceeded historical float-in (~105K), and `GREATEST(0, float_raw)` clamped the negative net to zero — hiding fresh deposits. Fix: anchor any agent whose `wallets.float_balance > 0`, strict float = 0, AND has a real `agent_float_deposit` cash_in row in the last 7 days. Anchor is set 1 second before that deposit's `created_at` so the deposit is included. Pre-anchor negative net is logged to `wallet_historical_drift_review` (status `pending_review`) for CFO write-down/recovery decision. Anchor reason tag: `float_legacy_negative_drag`. Agents with cached float but ZERO ledger justification (phantom cache) are intentionally NOT anchored — they need a separate CFO review.
