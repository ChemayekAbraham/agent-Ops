---
name: Partner portfolios fund from operational float
description: Ops-created partner portfolios (create-portfolio-invite, approve-pending-portfolio) gate on and debit float_balance, never withdrawable
type: feature
---
# Partner portfolio funding source = operational float (2026-09-08)

- `create-portfolio-invite` and `approve-pending-portfolio` gate on `funder_float_available(p_user_id)`, never `get_user_available_balance`.
- The `portfolio-funding-<id>` wallet debit leg posts `recipient_type='operational_wallet'`, `wallet_bucket='float'`, description tagged `float_usage=partner_portfolio_funding`.
- The approval path still adds this portfolio's own `funder_pending_portfolios` hold back before comparing (its own hold would otherwise make it look unfunded).
- Self-managed / self-support sources keep their existing skip: `approve_pending_portfolio` posts their float debit atomically (see mem://business-model/self-support-float-funding).
- Returns/ROI still credit `withdrawable`.
