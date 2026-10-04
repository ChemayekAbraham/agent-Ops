---
name: Promissory note funding (Phase 2)
description: COO approval of a promissory note with attached tenant plans commits the partner's own withdrawable money and raises a pending portfolio for Partner Ops; pledge SMS + email at note creation
type: feature
---
Flow: agent creates note (optionally earmarking ready-to-fund rent plans) → partner gets pledge SMS + email
(tenants + 15%/month, 12-month earnings) → COO approves → partner's withdrawable money is committed →
pending portfolio appears in Partner Ops → Partner Ops approval runs the existing self-managed path
(wallet debit, landlord float release, agent SMS, deployment email).

Rules:
- `psm_confirm_commitment_for(partner, ids, term, key, actor)` is the shared core; `partner_self_confirm_commitment`
  delegates to it. Never duplicate commitment logic.
- Notes with attached plans cannot be approved unless the partner is registered (`partner_user_id`),
  has signed their agreement, and has enough strict withdrawable balance. Errors: `PARTNER_NOT_REGISTERED`,
  `AGREEMENT_REQUIRED`, `PARTNER_FUNDS_SHORT`.
- Term is always 12 months for note-funded commitments; idempotency key `pnote-<note_id>`.
- Pledge notices queue in `promissory_note_pledge_notices`, drained by edge fn
  `notify-promissory-note-pledge` (client fire-and-forget + 10-min cron sweep). Email template
  `promissory-note-pledge`. SMS sender is always WELILE.
