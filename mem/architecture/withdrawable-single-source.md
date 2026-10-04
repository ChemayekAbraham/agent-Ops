---
name: Withdrawable single source
description: get_user_available_balance now delegates to v_user_wallet_strict, eliminating divergence between wallet UI and withdrawal guard
type: constraint
---
As of 2026-05-11, `get_user_available_balance(p_user_id)` returns `v_user_wallet_strict.withdrawable` directly (clamped >=0). It no longer maintains its own category blacklist.

Consequences:
- The wallet UI (`get_user_wallet_view`) and the withdrawal approval guard (`approve-withdrawal` edge fn) read the SAME figure. They cannot diverge.
- Any CFO Direct Credit with `recipient_type='user'` is routed by `wallet_route_for_category` into the `withdrawable` bucket → automatically counted as withdrawable.
- Do NOT reintroduce category blacklists in `get_user_available_balance`. If a category should be excluded, fix it inside `wallet_route_for_category` so the strict view (and therefore both UI and guard) reflect it consistently.
