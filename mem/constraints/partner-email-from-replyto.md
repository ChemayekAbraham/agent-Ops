---
name: Partner/funder email FROM + Reply-To
description: Partner/funder (investor) emails must send from partnership@welile.com and set Reply-To to partnership@welile.com
type: constraint
---
Partner / funder (investor/supporter) facing emails MUST:
- Send FROM `Welile Partnerships <partnership@welile.com>`
- Set `reply_to: partnership@welile.com`

Non-partner transactional emails keep the default `noreply@welile.com` and no reply_to.

Implementation:
- `send-transactional-email`: `PARTNER_FUNDER_TEMPLATES` set drives `PARTNER_FROM` + `PARTNER_REPLY_TO` (returns-disbursement, partner-wallet-deposit, partnership-agreement/topup/split-allocation/maturity-notice, partner-compound, partner-portfolio-compounded, portfolio-renewal/maturity/request-confirmation, partner-account-created, angel-pool-share-purchase, proxy-managed-payout-notice, tenant-partnership-agreement).
- `send-supporter-agreement-email` + `coo-broadcast-partners`: hardcode partnerships FROM + reply_to.
- `process-email-queue` forwards `payload.reply_to` to `sendLovableEmail`; the email-js `U()` send fn JSON-stringifies the whole payload, so any field (incl. reply_to) is forwarded to the Lovable email API.
