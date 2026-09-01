# Landlord Rental Accounting — Recommended Changes (not implemented)

This is the recommendation set from the read-only audit. Nothing here has been applied.

## 1. Decide the pricing model (business decision, blocks everything else)

The live formula prices a 30-day, UGX 100,000 placement at **UGX 143,000** (daily 4,767) and pays agent commission *out of* that. The reference rules price it at **UGX 156,310** (daily 4,877) with agent commission layered *on top* of principal + returns + residual.

Both are internally consistent. Only one can be the tenant obligation. Until this is settled, no ledger change should be made.

```text
LIVE      100,000 principal + 33,000 access fee + 10,000 reg   = 143,000
          of which ROI 15,000, agent commission 14,300, residual 3,700
INTENDED  100,000 principal + 15,000 ROI + 14,631 commission
          + 16,679 residual + 10,000 reg                       = 156,310
```

## 2. Single authoritative pricing function

Extend `compute_rent_repayment` to return the full component breakdown (principal, partner return, agent commission, registration fee, platform residual) instead of only access fee / total / daily. Keep `trg_enforce_rent_request_formula` as the sole writer of those columns.

Then retire the duplicated client math: `src/lib/rentCalculations.ts`, `PublicRentCalculator.tsx`, `mcp-public/tools/estimate-rent-access.ts`, `ReceivablesAudit.tsx` and the agent dialogs should read the RPC rather than recompute `1.33^(days/30)` and `× 0.10` locally.

## 3. Recognise fee revenue at collection

Today access fee and registration fee are effectively not recognised: `access_fee_collected` has 8 production legs, and `registration_fee_collected` posts an equal platform cash_in and cash_out so it self-nets. R1 Platform Revenue stands at UGX 11.4M against UGX 669M disbursed.

Every collection should split the collected amount into its components and post the fee share to R1 once, on one side only.

## 4. Use the liability accounts that already exist

`ledger_account_map` defines L3 Partner Returns Payable, L4 Landlord Rent Payable and L5 Agent Commission Payable. All three carry zero balance. Recommend:

- landlord principal recognised as L4 on placement, cleared to A1 on disbursement
- partner return accrued to L3, cleared on payout
- agent commission accrued to L5, cleared when it hits the withdrawable wallet

## 5. Pin the rates to config, not to code

`0.15` (partner return) and `0.10` (agent commission) are hardcoded in both the edge functions and roughly twenty frontend files. Move them to a single config table read by the pricing function, and have the UI display the values it receives.

## 6. Resolve the two commission functions

Two overloads of `credit_agent_rent_commission` exist — one at 10% flat, one at 5%/4% tiered. Confirm which resolves at each call site and drop the dead one.

## 7. Repoint the vestigial ledgers

`commission_accrual_ledger` and `fee_revenue_ledger` receive no writes from the current flow but are still read by CFO and agent dashboards. Either write to them from the live path or repoint those dashboards at `general_ledger`.

## Explicitly preserved

No change is proposed to the recent balance-sheet classification work: Partner and Agent Obligations, Angel Pool Shares, E3 Legacy Opening Balance Adjustments, E4 Legacy One-Sided Posting Counterparts, genuine A4 Agent Receivables, and the CFO wallet-deduction equity corrections all stay exactly as they are. The recommendations above add postings to accounts that are currently empty; they do not reclassify anything already mapped.
