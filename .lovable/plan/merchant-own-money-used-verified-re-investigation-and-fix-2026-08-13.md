# Merchant "own money used" — verified re-investigation and fix

## What the books actually show

I re-checked every claim against live data. Three of your findings are confirmed exactly. Several others are not supported by the ledger and must not be acted on, or we would erase real debts to agents.

### Confirmed

**1. Phantom over-reservation is real — your 26,632 figure is exact.**
Mudumba Samuel holds UGX 3,329 float but has 8 open claims each reserving the full 3,329 (8 x 3,329 = 26,632). Hilary Evanz: 11 claims x 3,500 = 38,500 against 3,500 float. Every one of those rows was created at a single identical timestamp with a reserved-before value of 0, so they were bulk-inserted rather than reserved one at a time. Available float therefore computes to 0 and new claims are refused — this is the "0 available / 26,632 reserved" popup.

**2. A receivable is raised on shortfall alone.** In the payout function, the float figure used to split "company float" from "own money" is simply the reservation amount; whatever the payout exceeds is written straight into the out-of-pocket table as "Own money fronted". No proof, attestation, or funding marker is required at that moment.

**3. Mass historical backfill inflated the numbers.** One agent alone has 715 telecom rows all stamped at the same instant on 12 Aug, spanning historical payouts totalling about UGX 84.7M. These are retrospective classifications, not observed events.

### Not supported by the data

**4. Company float IS checked, and the float figure is accurate.** For every agent sampled, float deposits minus settlements minus CFO corrections equals the current float balance to the shilling (Hilary: 63,581,106 in, 61,668,272 out, 1,680,334 CFO debits, 229,000 assigned, leaving 3,500 held). There is no ignored central pool: float is issued per agent, and these agents have genuinely spent theirs down to zero.

**5. The live reservation maths is correct.** It reads real float, subtracts what is already reserved, and reserves the lesser of that and the payout. The corrupt reservations came from the bulk insert, not from this logic.

**6. The CFO debits were deliberate.** The 480,334 / 1,200,000 / 901,300 / 1,019,047 float debits (29 Jul to 5 Aug) are reasoned CFO reversals and overpayment recoveries, not artifacts. They legitimately reduced float before 12 Aug.

**7. "No personal funding exists" cannot be concluded.** An agent's own cash never passes through their wallet ledger by design, so the absence of a wallet debit proves nothing either way. Meanwhile these payouts are marked completed and the customer was paid. So either the agent did front cash, or a payout is falsely marked paid. Auto-deleting the receivables would risk wiping genuine debts to agents.

**8. Scale is much larger than reported.** Pending "own money" receivables total roughly **UGX 5.97M across 19 agent groups**, not 504,650. The largest single one is UGX 1,647,515 (Sky Bubbles). The 337,700 / 504,650 figures were one agent's slice.

## Fix plan

**Step 1 — Release the phantom reservations.** Free the bulk-inserted reserved rows that have no live claim, and cap the reserved total so it can never exceed the agent's float. This alone restores available float and unblocks claiming for Hilary, Mudumba and anyone else affected.

**Step 2 — Make reservations self-healing.** Enforce one reservation per withdrawal, recompute the reserved-before figure from live state, and auto-release reservations whose withdrawal has reached a terminal state or gone stale, so locks cannot accumulate again.

**Step 3 — Stop raising unproven debts.** A shortfall alone will no longer create a reimbursement claim. New shortfalls are recorded as **"Unfunded company float"** for finance review. A reimbursement claim is only raised once there is evidence: payment proof attached to the payout, plus the merchant's explicit confirmation that they used their own money.

**Step 4 — Quarantine the 12 Aug backfill.** The bulk-created rows move from "pending reimbursement" to "needs review" so they stop presenting as confirmed company debt, while staying fully visible to Financial Ops to confirm agent by agent. Nothing is deleted.

**Step 5 — Relabel the merchant dashboard.** "Your own money used" becomes "Awaiting finance review" for unverified amounts, and only confirmed amounts show as money owed to the agent. "Company cash in your hands" stays presented as company money held, never as agent debt.

**Step 6 — Keep the workflow moving.** With float restored, claims proceed normally. The 500,000 fronting limit stays, but the block message tells the agent to request float from Finance, and Financial Ops can top the agent's float up from the merchant agents page.

## Technical notes

- Reservation repair and the reserved-versus-float cap live in `reserve_merchant_float` and `merchant_reserved_float`, plus a data repair for the bulk-inserted `merchant_float_reservations` rows.
- The classification change is in `supabase/functions/approve-withdrawal/index.ts`, where `merchantPrincipalShortfall` currently writes directly into `merchant_out_of_pocket_advances`. The evidence gate already modelled in `classify_merchant_payout_funding` becomes the single rule.
- `merchant_out_of_pocket_advances` gains a review status; `get_merchant_out_of_pocket_summary` splits confirmed from under-review so "Finance owes you" and the merchant card stop disagreeing.
- Dashboard labels: `MerchantFloatAvailableCard.tsx` and `useMerchantFloat.ts`.
- No agent receivable is deleted anywhere in this plan.