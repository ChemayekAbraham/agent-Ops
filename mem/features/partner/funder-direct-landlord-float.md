---
name: Funder direct landlord-float support
description: Funder supporting a tenant from the card releases wallet/operational float straight to the agent landlord float, or files a landlord float receivable with a mandatory promised deposit date
type: feature
---
# Direct funder support (2026-08-23)

RPC `funder_support_tenant_direct(p_rent_request_ids uuid[], p_promised_deposit_date date, p_term_months int)`:

- Capacity = `funder_support_capacity(uid)` = strict withdrawable (`get_user_available_balance`) + `v_user_wallet_strict.float_balance`.
- Covered → commitment via `psm_confirm_commitment_for(..., p_funding_mode)`; wallet debit posted
  withdrawable-first then float (`supporter_rent_fund` wallet leg + `partner_funding` platform leg,
  `wallet_bucket` withdrawable/float, `recipient_type` user/operational_wallet, idempotency
  `psm-commit-<commitment>`), commitment + portfolio flipped active, then
  `psm_disburse_landlord_float` releases onto the tenant's agent landlord float.
  Owner release is permitted by the session flag `psm.owner_release='on'` honoured inside
  `psm_is_topup_reviewer` — set local, reset immediately after the call.
- Not covered → NOTHING is debited. Rows land in `landlord_float_receivables`
  (funder, commitment, rent request, landlord, tenant, agent, amount, `promised_deposit_date` NOT NULL,
  status outstanding/settled/cancelled; unique outstanding row per rent request).
  A deposit date is mandatory and must not be in the past (`DEPOSIT_DATE_REQUIRED` /
  `DEPOSIT_DATE_IN_PAST`). Portfolio stays `pending_ops_approval`.
- `psm_confirm_commitment_for` gained `p_funding_mode` ('withdrawable' default | 'float' | 'receivable');
  only the capacity guard varies. Do not remove the default — legacy callers rely on it.
- UI: third option "Support this landlord now" in `SelfPortfolioDeployDialog`, with the deposit-date
  input shown only when capacity < total.
