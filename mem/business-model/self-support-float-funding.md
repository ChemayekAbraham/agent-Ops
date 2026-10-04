---
name: Self-support portfolios fund from operational float
description: Partner self-support portfolios (rent plans and verified empty houses) and their top-ups draw principal from float_balance, never withdrawable; returns still pay to withdrawable
type: feature
---
# Self-support funding source = operational float (2026-09-01)

- `public.funder_float_available(user)` = `get_user_float_available_balance` − `funder_pending_hold`. It is the ONLY gate for self-support funding. service_role EXECUTE only; callers are SECURITY DEFINER.
- Gated on float: `psm_confirm_commitment_for` (`p_funding_mode` now defaults to `float`), `partner_support_houses` (both overloads), `partner_self_top_up`, `partner_self_topup_eligibility`, `partner_self_list_fundable_plans` (`available_balance`), `partner_ops_approve_self_topup`.
- Debit legs in `approve_pending_portfolio` (`self_managed`, `self_managed_house`) and `partner_ops_approve_self_topup` post `recipient_type='operational_wallet'`, `wallet_bucket='float'`.
- Float consumption is tagged in the leg description: `float_usage=self_portfolio_funding` (rent plans / top-ups) and `float_usage=house_support_funding` (empty houses). `general_ledger` has no metadata column and `create_ledger_transaction` does not pass `sub_category`, so the description carries the tag.
- ROI/returns unchanged: they still credit `withdrawable`. Principal on redemption must return to float, never withdrawable.
- Known gap: `funder_pending_portfolios.source = 'self_managed_house_topup'` still falls into the generic ELSE branch of `approve_pending_portfolio` (withdrawable leg, and its `psh-commit-` idempotency key replays), so house top-ups are not float-routed yet.
- **NEVER pre-debit withdrawable in the approval edge function (fixed 2026-09-01).** `approve-pending-portfolio` posts its generic `portfolio-funding-<id>` withdrawable debit ONLY for the rent-pool source; it MUST skip that pre-debit when `funder_pending_portfolios.source` is `self_managed` or `self_managed_house`, because `approve_pending_portfolio` already posts the float debit (`psm-commit-*` / `psh-commit-*`) atomically with `psm_disburse_landlord_float`. Without the skip the partner is charged twice, the second time out of the wrong bucket (this hit house portfolio WSH-9681 on 2026-08-31).
- Submit path (`funder_support_tenant_direct`) debits nothing and releases nothing: it leaves the portfolio in `pending_ops_approval` with a genuinely `pending` vetting row. Sufficient balance is NOT self-approval.
- Releases/reversals refund into the **float** bucket, never withdrawable (e.g. `psm-commit-revert-<commitment>`).
