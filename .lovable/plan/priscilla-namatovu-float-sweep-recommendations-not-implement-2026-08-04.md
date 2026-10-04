# Priscilla Namatovu float sweep — recommendations (not implemented)

Investigation is complete and read-only. Nothing was modified. The UGX 550,000 was manually swept out of her Float on 03 Aug 2026 13:52 UTC by a Financial Ops operator using the FinOps Wallet Move tool ("error correction" mode, reason "not supposed have"). The money is not lost — it sits on the platform side of the ledger — but the customer was never told, and the same pattern has hit 33 users for UGX 70.7M.

## What to change (pending your approval)

### 1. Restore Priscilla's funds to the correct bucket
Re-post the UGX 550,000 to her wallet in the bucket you decide is correct (Withdrawable if this was funder capital, Float if operational), through the sanctioned ledger path only. Requires an explicit decision from you on the destination bucket, because the original deposits were auto-routed to Float by the "agent user, float-by-default" rule and the reason text does not say where they should have gone.

### 2. Notify the customer on every FinOps wallet move
Today the tool posts the ledger legs, updates the projection and writes an audit row, but sends no SMS or notification. Add a customer SMS on both `error_correction` and `user_to_user` moves, stating amount, bucket, new balance and a support contact. Without this, every sweep looks like disappeared money to the customer.

### 3. Force a structured reason instead of free text
Replace the 10-character free-text reason with a required reason code (duplicate credit, wrong bucket, wrong user, fraud hold, reconciliation, other + note). The 03 Aug batch shows why: reasons recorded include "not suposed h", "notb va;igbf", "noy supposed have", "noyt valid sn" — unusable for audit or for answering a customer query.

### 4. Two-step confirmation when the sweep equals the user's entire deposit history
15 of 42 float error corrections removed exactly the user's full lifetime float deposits. Require a second confirmation, and surface the user's deposit history inline, when the requested amount equals or exceeds total deposits.

### 5. Fix the upstream cause: float-by-default routing on auto-created deposits
Her two deposits were auto-created from Gmail MoMo receipts and routed to Operational Float purely because she holds the `agent` role (`inference_reason: agent_float_by_default`). She has zero collections, zero rent requests and zero withdrawals — she behaves as a funder, not a collecting agent. Route auto-created deposits by observed behaviour, or hold ambiguous ones for operator classification, so the sweep is not needed in the first place.

### 6. Review the other 32 affected users
Produce a reconciliation list of all 42 float error corrections (UGX 70.7M, 03 Jun – 04 Aug 2026), flag the 15 full-history sweeps, and decide per case: legitimate correction, or funds owed back to the customer.

## Technical notes

- Sweep transaction group `140270cb-01bd-481d-a87e-bb4a863ae6ad`, reference `ECW-65B721DF4A`. Balanced two-leg posting: wallet leg `agent_float_assignment` cash_out 550,000 (classification `production`), platform leg `system_balance_correction` cash_in 550,000 (classification `admin_correction`).
- Both deposits posted correctly and remain intact: groups `9d5980fc…` (500,000, TID 42434566528, 31 Jul) and `d473ee2d…` (50,000, TID 42480970988, 02 Aug), each a balanced wallet/platform pair from `deposit_requests`.
- Balance layers all agree at zero: `wallets`, `wallet_balances_projection` (ledger_version 4), `v_user_wallet_strict`. No drift, no imbalance.
- Path executed: `FinOpsWalletMovePanel` → `finops-wallet-move` edge function → role check (`cfo, manager, super_admin, cto, operations`) → treasury guard → no-overdraw pre-check → `create_ledger_transaction` → projection trigger → `audit_logs`. No notification step exists in that chain.
- Operator: Nankambo sharimah (`59d45ad2-0d44-433c-b4ec-20927a25c281`), holding cto/cfo/manager/operations/super_admin. Authorisation was valid; no bypass, no service-role backdoor, no trigger involvement.
- Restoration in item 1 must go through `create_ledger_transaction` with explicit `wallet_bucket` + `recipient_type` (Routing v2). No direct wallet-column writes; historical rows stay untouched and the reversal is posted forward.