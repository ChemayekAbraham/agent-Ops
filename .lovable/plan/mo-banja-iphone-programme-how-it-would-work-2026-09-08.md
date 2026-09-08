# Mo Banja iPhone programme — how it would work

Write-up only. No code changes in this pass.

## The arrangement

- Mo Banja sells iPhones to Ugandans on credit and requires a down payment of at least 40% of the phone price.
- Welile funds that down payment for good-standing agents and earns interest on the funded amount.
- Every price shown on an iPhone today is the Mo Banja down payment, not the phone price. We only hold the down payment figure, so screens should never imply the amount is the full cost of the phone.
- After the phone is issued, the agent repays two parties at once: Welile daily (inside the app) and Mo Banja weekly (outside the app, no money flows through Welile for that leg).
- Welile's daily recovery stays exactly as it is now — taken from the agent's commission or from a deposit the agent makes into their wallet.
- If an agent stops paying Welile, Welile contacts Mo Banja by phone or email and Mo Banja can remotely lock the handset. This stays a manual, off-platform step for now.

## What the screens should say

Agent-facing (iPhone order and order-status screens):
- Label the amount as "Down payment funded by Welile" rather than "Phone amount", with a short note that Mo Banja sets this minimum and the rest of the phone price is owed to Mo Banja directly.
- State the two obligations plainly on one line each: "Pay Welile <amount> daily from your wallet or commission" and "Pay Mo Banja weekly, directly to Mo Banja".
- A short compliance notice: Mo Banja installs remote management software and can lock the iPhone if repayment stops on either side.
- Keep the interest/total-repayable figures already displayed unchanged.

Agent Ops (pending applications and programme views):
- Same relabelling of the amount as a down payment.
- Keep the existing projection/interest column, described as Welile's recovery on the funded down payment.
- Note beside each approved order that the Mo Banja weekly leg is settled outside the platform, so a clean Welile record does not mean the agent is current with Mo Banja.

## What stays untouched

- Repayment amounts, interest rates, period grid, eligibility caps, approval chain (Agent Ops → COO → CFO), wallet deductions, ledger postings.
- No new tables, columns, RPCs, or migrations. No full-phone-price field, since we do not have that data.
- No in-app lock-request workflow.

## Technical note

The changes described are copy and presentation only, in the iPhone order dialog, the order-status card, the device-access dialog, and the Agent Ops smartphone application list. The pricing helper (`smartphoneSchedule`) and all money paths are unchanged.

## Next step

Approve this and I will apply the wording and disclosures across those screens.
