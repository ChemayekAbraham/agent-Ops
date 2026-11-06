# Partner renewal emails

## What the partner will receive

1. **When they ask to renew**: a new "We've received your renewal request" email. It replaces the generic request confirmation, for renewals only. It shows:
   - the portfolio and its current amount,
   - the maturity date,
   - the request reference,
   - a three-step timeline: Request received, then Partner Ops review, then Renewal applied.

   Redemption and other request types keep their current email. The Partnership Team alert stays as it is.
2. **When the renewal is applied**: two emails.
   - **"Your Returns are ready"**: a new email styled like the redemption-paid one. It says the final cycle's Returns from this portfolio have been paid into the partner's Welile wallet and can be withdrawn now. The amount appears only when it can be read from the actual payout record. It never shows a guessed figure.
   - **The existing renewal confirmation**, unchanged: new term, maturity date and rate.

   Both emails go out wherever a renewal is applied:
   - Partner Ops approving a renewal for a portfolio that has already matured,
   - the nightly job that applies scheduled or held renewals.

## Safeguards
- Each email has its own duplicate-protection key, so a retry never sends it twice.
- Placeholder addresses (`@welile.user`) are skipped, as they are today.
- The wording uses "Returns", "Supporter" and "Rent Plan" only.
- If an email fails, the renewal still goes ahead.
- No money movement, database or renewal-rule changes.

## Technical details
- New templates `portfolio-renewal-request-received.tsx` and `portfolio-renewal-returns-ready.tsx`, registered in `registry.ts`.
- `submit-portfolio-action-request`: when `requestType === RENEWAL_REQUEST`, use the new template.
- Add a shared helper that sends the Returns-ready email. Call it before the existing renewal email in `process-portfolio-renewal` (renewed-now path) and in `apply-scheduled-portfolio-renewals`.
- Read the amount through a read-only lookup of the latest Returns payout ledger entry for the portfolio. If none is found, leave the amount out.
- Deploy the three changed functions plus `send-transactional-email`, then render-check both templates with preview data.
