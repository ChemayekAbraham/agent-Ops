---
name: Merchant float requests — CFO owns allocation (forecast removed)
description: The per-agent MerchantFloatDemandCard "fair-share" forecast was removed. Merchant agents request any amount via MerchantFloatRequestCard; the CFO decides. Do not reintroduce per-agent forecasting/self-allocation.
type: constraint
---
**Decision (2026-07-06, Option A):** The per-agent float **demand forecast / fair-share** widget (`MerchantFloatDemandCard`) was deleted. It was misleading — it looked authoritative but bound nothing, and enabled a double-request loophole: the shared `net_gap = demand − network_float − pending_requested` recomputed with a lag after CFO approval and had no per-agent cap, so an agent could click "Request fair share" repeatedly and get double-funded.

**Current model — CFO is the gatekeeper.** Merchant (cash-out) agents request float through `MerchantFloatRequestCard` only:
- Free-text amount + reason → inserts a `float_requests` row (status `pending`) → CFO "Pay to Wallet" queue → funded under Agent Float Allocation (recipient_type `operational_wallet` → Float bucket).
- Double-request safe: `hasPending` disables the button AND the mutation rejects while any `pending` request exists.
- The request card is always available (`showRequest = true`), with a low-float (<UGX 100,000) amber alert as a hint.
- Coordination/forecasting of the shared payout pool is the CFO's job on the CFO side, not per-agent.

**Do NOT reintroduce:** per-agent float demand forecasting, "fair-share" auto-computed request amounts, or any client-side self-service float allocation. Doing that correctly needs real backend work (claim locks, race-condition handling, spend-down tracking) and is only justified if agents self-serve float at scale — which we explicitly rejected.

The `get_merchant_float_network_status()` RPC is now unused by the UI (only a dead type ref remains in generated types). Safe to leave; do not build new UI on it.
