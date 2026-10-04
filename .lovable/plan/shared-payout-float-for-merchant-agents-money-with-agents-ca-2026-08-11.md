# Shared Payout Float for Merchant Agents + "Money With Agents" card

## The idea, in plain words
Today every merchant agent sees only the float Finance has already pushed to them, so they hesitate to pay. The change flips it: the company's whole payable obligation (all withdrawable wallet balances + landlord payout float) becomes ONE shared pool that every merchant agent can see as "Float available to pay out". They claim a withdrawal, pay it from their own phone, the pool drops by that amount, and their personal "Cash owed to me by Finance" rises. Finance then sends real MTN/Airtel money; the extracted email confirms it and cancels the debt. If Finance sent money before any claim, that money is company cash sitting in the agent's hands and must be visible.

## What gets built

### 1. Shared float pool (read-only, derived)
New RPC `get_merchant_payout_float()` returning:
- `withdrawable_total` — from the existing strict wallet source (`get_wallet_totals` / strict view), never recomputed by hand
- `landlord_float_total` — outstanding agent landlord payout float
- `claimed_unsettled_total` — amounts currently claimed but not yet confirmed paid
- `available_float = withdrawable_total + landlord_float_total − claimed_unsettled_total`

No wallet or ledger writes. This is a display/derivation layer only, so the wallet sole-writer and ledger fortress rules stay intact.

### 2. Per-agent settlement position
New view + RPC `get_merchant_float_positions()`, one row per merchant (cash-out desk):
- `paid_out_total` — principal this merchant settled from their own phone (from confirmed cash-out settlements)
- `reimbursed_total` — real money Finance actually sent them, taken from the extracted email/MoMo feed (outgoing transactions matched to that merchant's MTN/Airtel number) plus recorded float credits
- `owed_to_agent = max(0, paid_out_total − reimbursed_total)` — what the merchant may legitimately demand
- `company_cash_with_agent = max(0, reimbursed_total − paid_out_total)` — company money advanced but not yet worked off
- last reimbursement time and last payout time

Rule enforced in the UI copy and in the request form: a merchant can only demand what they have already claimed and paid. Anything received beyond that is flagged as company cash in their hands, not as their money.

### 3. Merchant agent dashboard
On `MerchantDashboardHome` / cash-out payouts tab, add a float header card:
- Big number: **Float available to pay out** (shared pool)
- Secondary: **Cash Finance owes you** and, when applicable, a warning chip **Company cash in your hands**
- Claiming stays exactly as it is today; the card just reflects the position and refreshes on claim/settle via the existing realtime invalidation.

### 4. Financial Ops card — directly below the actual-money card
New `MoneyWithAgentsCard` inserted immediately under `PhoneMoneyCard` in the Financial Ops overview:
- Header totals: **Company money in agents' hands**, **Owed to agents**, net exposure
- Per-agent rows (name, phone, paid out, reimbursed, owed / holding) sorted by biggest exposure
- Each row links into the existing Cash-Out Settlement Timeline for the ledger trail
- Reimbursement itself continues to run through the existing float/requisition path — this card is the truth board, not a new payment button.

## Guardrails
- No new wallet mutation path; `apply_wallet_movement` remains the only writer.
- Reimbursements are recognised only from the extracted email feed or an existing recorded float credit, so the board cannot be inflated by hand.
- Everything is additive: existing claim, settle, proof-of-payment and permission rules are untouched.

## Verification
- Financial Ops overview shows the new card right under actual money, with totals reconciling to the settlement timeline.
- A merchant agent sees a non-zero available float and, after settling a payout, an increased "Finance owes you".
- An agent given money before claiming shows as company cash in hand on the Finance board.
