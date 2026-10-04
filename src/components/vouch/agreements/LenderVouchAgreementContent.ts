export const LENDER_VOUCH_AGREEMENT_VERSION = 'v1.0';

export const LENDER_VOUCH_AGREEMENT_TEXT = `WELILE LENDER VOUCH AGREEMENT
(Partner Lender Terms — Welile Trust Network)

Platform: welile.com
Company: Welile Technologies Limited ("Welile", "we", "us")
Lender: Registered Welile Lending Partner ("Lender", "you")
Effective Date: [Auto-filled]
Version: v1.0

By clicking "I Agree", you confirm you have read, understood, and accepted these Terms.

1) PURPOSE

These Terms govern your participation as a registered Lending Partner on Welile. They define how you may use the Welile Trust Profile of any Welile user to make lending decisions, and how Welile will VOUCH for that user up to a published limit ("Vouched Amount").

2) WHAT WELILE VOUCHES

2.1 Welile generates a "Welile Trust Profile" for every active user, computed from:
   • Verified identity & GPS findability
   • Rent payment history through Welile
   • Wallet & cash-flow behaviour
   • Supporter/portfolio activity
   • Network (referrals, sub-agents, landlord listings)
   • Movement & shopping behaviour signals

2.2 Each profile shows a "Welile Vouches Up To" amount (the "Vouched Amount") in UGX. This is the MAXIMUM amount Welile will guarantee for that user under this Agreement.

2.3 The Vouched Amount can change as the user's behaviour changes. The Vouched Amount in force for any single loan is the value DISPLAYED at the time the Lender records the loan in Welile.

3) HOW TO LEND UNDER THIS AGREEMENT

3.1 The Lender must be:
   • A registered Lending Partner with KYC completed
   • In good standing (active, not suspended)
   • Bound to this Agreement (current version)

3.2 To benefit from the Welile Vouch on a loan, the Lender MUST record the loan inside the Welile platform BEFORE OR AT THE TIME of disbursement. Required fields:
   • Borrower Welile AI ID
   • Principal disbursed
   • Disbursement date
   • Expected repayment date
   • External loan reference (Lender's own ID)

3.3 If the loan is NOT recorded in Welile, NO vouch applies. The Lender bears 100% of the risk.

3.4 The recorded loan creates a "Vouch Claim" record. The borrower will be notified of the recording.

4) WHAT WELILE PAYS IF THE BORROWER DEFAULTS

4.1 A loan is in DEFAULT when the borrower has failed to repay the principal in full, AT LEAST 30 calendar days after the expected repayment date AND the Lender has marked the loan as defaulted in Welile.

4.2 Upon a confirmed default and submission of evidence (basic loan agreement + proof of disbursement + proof of overdue), Welile will pay the Lender the LESSER of:
   (a) the unpaid principal still owed by the borrower, OR
   (b) the Vouched Amount that was displayed at the time the loan was recorded.

4.3 Welile DOES NOT cover:
   • Interest, late fees, penalties, collection costs charged by the Lender
   • Loan amounts ABOVE the Vouched Amount
   • Loans NOT recorded in Welile before disbursement
   • Loans to users whose Trust Score has been MARKED FRAUDULENT before disbursement
   • Disputes the borrower can prove (e.g., loan never disbursed, identity theft)

4.4 Welile pays out within 14 working days of dispute clearance.

5) AFTER WELILE PAYS

5.1 Once Welile pays a claim, the debt is OWED TO WELILE by the borrower. The Lender assigns the right to recover that amount to Welile.

5.2 Welile will recover from the borrower via:
   • Wallet balance auto-deduction on any future credit
   • Trust Score penalty (typically -30 to -50 points)
   • Restriction from new vouches for at least 6 months
   • Lawful collection through agents and partners

5.3 The Lender agrees to cooperate with any reasonable investigation.

6) LENDER OBLIGATIONS

The Lender agrees to:
   • Verify borrower identity at disbursement (national ID match with Welile profile)
   • Use a written loan agreement with the borrower
   • Disclose interest rate, fees and total cost CLEARLY to the borrower
   • Comply with all Ugandan consumer-credit and tier-4 microfinance regulations
   • Not to lend MORE than the displayed Vouched Amount and expect a full vouch
   • Mark loans as repaid promptly (within 7 days of full repayment)
   • Not to share borrower data outside the lending purpose
   • Not to use Welile data for marketing without consent

7) PROHIBITED CONDUCT

The Lender must NEVER:
   • Threaten, harass, or shame borrowers
   • Charge interest beyond legal limits
   • Confiscate property, ID documents, or personal items
   • Engage in predatory roll-overs designed to extract fees
   • Falsely report defaults to inflate claims
   • Lend to users who appear coerced or impersonated

Violation = immediate termination + claim forfeiture + possible legal reporting.

8) FEES (BETA)

8.1 During the beta period, Welile charges NO vouch fee.
8.2 Welile reserves the right to introduce a vouch fee (announced at least 30 days in advance) once the network matures.

9) DATA & PRIVACY

9.1 Borrower data shown via the Welile Trust Profile is for THIS LENDING DECISION ONLY.
9.2 The Lender may not store, resell, or share borrower data with third parties.
9.3 The Lender must delete borrower personal data within 90 days of full loan closure.

10) DISPUTES

Disputes between Lender and borrower must first be raised inside Welile. Welile may mediate but is not a court. Either party retains the right to lawful action.

11) TERMINATION

11.1 Either party may terminate this Agreement with 30 days' notice.
11.2 Welile may suspend immediately for fraud, abuse, regulatory breach, or reputational harm.
11.3 Active vouches at termination remain in force until the underlying loans close.

12) LIMITATION OF LIABILITY

Welile's MAXIMUM liability under this Agreement for any single loan is the Vouched Amount displayed at the time the loan was recorded. Welile is not liable for the Lender's own operational losses, opportunity cost, or reputational damage.

13) GOVERNING LAW

These Terms are governed by the laws of Uganda.

14) ACCEPTANCE

By clicking "I Agree", you confirm that:
   • You are authorised to bind your lending entity
   • You understand the Vouched Amount is a CAP, not the loan amount
   • You will record EVERY loan inside Welile to claim the vouch
   • You accept Welile's right to recover from the borrower after payout
   • You accept the prohibitions in Section 7`;
