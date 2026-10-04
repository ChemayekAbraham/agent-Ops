---
name: Merchant cash-out settlement — float consumption, not reimbursement
description: SUPERSEDED 2026-08 — merchant agents settle from COMPANY FLOAT, not their own cash; only the 0.5% commission reaches their withdrawable wallet, principal is never credited there
type: feature
---
**Corrected 2026-08-14** (see `docs/investigations/Financial_Ops_Wallets_Merchant_Agents_Verified_2026-08-14.md`).
The model described below this line until 2026-06 is **no longer what the code does**. Kept for history;
do not implement against it.

**Current model.** A merchant (cashout) agent pays the withdrawing user out of **company float**
(`wallets.float_balance`), not their own personal cash. In `approve-withdrawal`, when the settler is
resolved server-side as a merchant (`resolve_payout_merchant_identity`), the settlement chain is:

1. **Float reservation** (`reserve_merchant_float`) against the shared company payout pool.
2. **Principal float debit** — wallet `cash_out` `wallet_bucket:'float'` `agent_float_settlement` ↔
   platform `cash_in`. Idempotency key `approve-withdrawal-merchant-float-consume-<withdrawal_id>`.
3. **Telecom sending-charge float debit**, same bucket, key `...-merchant-telecom-charge-<withdrawal_id>`.
4. Any shortfall is filed as `needs_review` in `merchant_out_of_pocket_advances` — not silent debt.
5. Reservation closed via `consume_merchant_float`.
6. **0.5% commission** — `round(amount*0.005)`, category `agent_commission_earned`, wallet
   `wallet_bucket:'withdrawable'`, key `...-cashout-commission-<withdrawal_id>`.

The code's own comment is explicit: *"Merchant agents no longer front their own cash for a withdrawable
reimbursement. They hold COMPANY FLOAT … nothing ever lands in the merchant's withdrawable"*
(`supabase/functions/approve-withdrawal/index.ts:2794-2801`). The response field `merchant_reimbursed`
is now populated with `merchantFloatConsumed`, not a withdrawable credit. **Only the 0.5% commission
ever reaches the agent's own withdrawable money.**

`docs/merchant-agent-payout-process.md:44-54` still describes the old reimbursement model and has not
yet been updated to match.

---

*(Original 2026-06 description, superseded — kept for history:)* A merchant (cashout) agent pays the
withdrawing user out of their OWN MTN/Airtel float. In `approve-withdrawal`, when the settler is an
active `cashout_agents` row (`isCashoutAgent`), the function posted TWO credits to the merchant's
**withdrawable** wallet: (1) principal reimbursement, full payout `amount`, category
`wallet_withdrawal`; (2) 0.5% commission. This full-principal-to-withdrawable step has been removed.
