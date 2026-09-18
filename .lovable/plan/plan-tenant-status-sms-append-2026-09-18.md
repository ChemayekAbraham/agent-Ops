# Plan: Tenant status SMS append

## What will change
- Add the three requested status-based SMS paragraphs to existing tenant notification messages.
- Use the existing tracked campaign short-code flow for the agent sign-up link in paragraph C.
- Add `/join/{shortCode}` as a friendly alias that resolves through the existing campaign redirect logic, without changing the current `/c/{slug}/{code}` and `/c/{code}` links.

## Backend/database
- Add a read-only resolver function that classifies a tenant into one of:
  - active, repaying, within cycle
  - completed funded plan
  - paying but outside their cycle
- Base the resolver only on existing authoritative sources: live rent-plan eligibility, schedule dates, repayment status, landlord-paid evidence, and recorded collections.
- Store the requested message paragraphs in the existing notification template system via a new `{{status_appendix}}` placeholder.
- Do not change payment, collection, repayment, accounting, wallet, ledger, or Rent Plan records.

## SMS functions
- Pass `status_appendix` into existing tenant message senders.
- Generate the outside-cycle agent CTA from the existing active recruitment campaign link, using `welileapp.com/join/{shortCode}`.
- Keep current send frequency, episode keys, opt-outs, and routing unchanged.

## Verification
- Use dry-run sender calls to confirm rendered sample messages without sending live SMS.
- Check the preview build signal after edits.

## Security notes
- The three active RLS findings would change database access behavior if fixed. I will not change them without a separate product/security decision.
