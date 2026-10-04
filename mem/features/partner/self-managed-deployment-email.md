---
name: Self-managed deployment email
description: Self-managed (partner-picked-tenants) portfolios send partner-self-managed-deployment on Partner Ops approval, not partnership-agreement
type: feature
---
When Partner Ops approves a pending portfolio:
- `funder_pending_portfolios.source = 'self_managed'` → send template `partner-self-managed-deployment` (tenant list built from `partner_self_funding_lines` → `rent_requests` → `profiles`), idempotency `partner-self-managed-deployment-<portfolio_id>`.
- Any other source → existing `partnership-agreement` email.
Approval must go through the `approve-pending-portfolio` edge function (the Partner Ops queue invokes it, not the RPC directly) or no email is dispatched.
Template is registered in `_shared/transactional-email-templates/registry.ts` and in `send-transactional-email`'s `PARTNER_FUNDER_TEMPLATES` (partnership@ FROM + Reply-To).
