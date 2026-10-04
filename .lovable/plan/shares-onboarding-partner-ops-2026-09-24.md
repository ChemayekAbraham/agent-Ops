# Shares Onboarding (Partner Ops)

## What the user gets

A new **Shares** section in the Partner Ops side menu with one item, **Shares Onboarding**. It has three tabs:

1. **Create** – Partner Ops picks an existing user, or enters a new person's name, phone and email. They enter the amount (or the number of shares). The screen shows the number of shares, ownership of the pool, ownership of the company and the person's wallet balance, using the same maths as the agent Angel Pool (UGX 20,000 per share, 25,000 shares, the pool holds 8% of Welile). On submit, the "Your Shares Have Been Created" email (the one you uploaded) is sent with a **Review & Sign Agreement** button.
2. **Submitted / Vetting** – a list with statuses: Awaiting signature, Submitted, Completed, Cancelled. Opening a submitted record shows a live preview of the contract, in the same style as partner-onboarding. Partner Ops fills in the Welile representative's details and signature, then approves.
3. **Completed** – signed contracts, with download and resend buttons.

**Shareholder signing page** – the same look and flow as the partner portfolio invite page:
- The shareholder must be signed in to the invited account.
- Their name, phone and email are filled in for them, and only when those details exist on their account.
- They add only the signature and date, then submit.

**Final email** – the existing share-purchase confirmation email, with its download button. The Early Angel Pool Shareholders Agreement (the one you uploaded) is attached as a PDF, filled in with both parties' details. A BCC copy goes to partnership@welile.com.

## Flow

```text
Partner Ops creates  ->  email to shareholder (Review & Sign)
  -> shareholder signs in, reviews contract, signs  -> status Submitted
  -> Partner Ops vets, previews, countersigns       -> wallet debited, shares confirmed
  -> final email + PDF attached, BCC partnership@welile.com
```

## Money rule (important)

- The wallet balance is checked when the shares are created, so Partner Ops sees immediately if the person can't afford them.
- **The actual wallet debit happens only when Partner Ops countersigns.** This way nobody pays for shares whose contract was never signed. The balance is checked again at that point.
- The debit uses the same balanced entry the Angel Pool purchase uses, and it is posted by the server, never by the browser.
- It also uses the same "shares still available" limit (25,000 shares), which counts shares already reserved by pending invites.
- New people added without an account get one created, the same way the partner invite does. They need money in their wallet before countersigning can succeed.
- Cancelling before countersign moves no money.

## Technical details

**Database (one new migration)**
- `share_onboarding_requests`: shareholder, created_by, amount, shares, pool and company percentages, reference (`ANG…` format), status (`awaiting_signature | submitted | completed | cancelled`), shareholder name/date/signature, company representative name/position/signature/date, pdf_path, angel_pool_investment_id, token hash, expiry, timestamps. It has access rules, grants and an index on (status, created_at).
- Two server functions:
  - `share_onboarding_submit(token, signature, name)` – shareholder side.
  - `share_onboarding_list(status, search, page)` – one query that returns the rows with names already attached, so there are no repeated lookups per row.
- Every change is recorded as a system event and an audit log entry.

**Backend functions (new, deployed by name)**
- `create-share-onboarding` – checks the Partner Ops role, creates the account for new people (reusing the partner-invite account logic), checks balance and share supply, stores a hashed token (7-day link), and sends the new `shareholder-shares-created` email.
- `resend-share-onboarding-invite` – sends a fresh link.
- `finalize-share-onboarding` – countersign: checks the balance again, posts the balanced ledger entry, inserts the `angel_pool_investments` row, stores the client-rendered PDF, and sends the confirmation email with the PDF attached and a BCC to partnership@welile.com.
- Shared share maths goes into `_shared/angelPoolShares.ts`, so the server-side copies of the share maths are no longer maintained separately.

**Frontend**
- Navigation: add `shares.onboarding` in `partnerOpsNav.ts` and a render branch in `PartnersOpsDashboard.tsx`.
- `src/components/executive/shares/`: `SharesOnboardingPanel`, `CreateShareholderDialog`, `ShareVettingDialog` (reuses the partner sign-off preview and PDF approach), and `shareAgreementTemplate.ts` (built from the uploaded agreement).
- New page `/shares/:requestId/sign` that reuses the portfolio-completion sign-in gate and the signature pad.
- Data hooks use React Query with a single list query and fresh reads before countersigning. The layout works on mobile and desktop.
- Email templates: `shareholder-shares-created.tsx` (from the upload) and the confirmation template extended with the attachment.

**Checks:** a typecheck and the project's safety checks run automatically. I will test one full flow without real money movement.
