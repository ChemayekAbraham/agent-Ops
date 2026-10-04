---
name: Partial and full capital redemption
description: Partner Ops redemption processing — full vs partial principal release, remaining principal stays invested, audit + email
type: feature
---
When Partner Ops processes a REDEMPTION_REQUEST they must choose scope:
- **Full redemption** — entire principal released, `investor_portfolios.investment_amount = 0`, status `redeemed` (portfolio closed).
- **Partial redemption** — the entered amount is released, portfolio stays `active` and principal is permanently reduced to `old_principal - redeemed_amount`. All future returns are calculated on that reduced principal ("Principal that stays invested").

Rules:
- Only `apply_portfolio_redemption(p_request_id, p_scope, p_amount, p_note, p_processed_by, p_is_test)` may apply a redemption. It is atomic, rejects `amount_exceeds_principal`, and rejects replays with `already_completed`.
- Every application writes an audit row to `portfolio_redemptions` (scope, old_principal, redeemed_amount, remaining_principal, is_test).
- `portfolio_action_requests` stores `redemption_scope`, `redemption_amount`, `remaining_principal`, `processed_by`, `processed_at`, `processing_note`.
- Partner notification uses the `portfolio-redemption` transactional template (partner/funder mailbox: partnership@welile.com). Partial copy MUST state the amount released AND the principal that stays invested; full copy confirms closure.
