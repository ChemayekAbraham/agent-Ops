# Balance Sheet — "Unclassified — flagged for review" investigation

Read-only investigation. No code, data, mappings or UI were changed.

## Root cause (one cause, not ten)

The flagged section is **not** a data problem, a Chart of Accounts gap, or a broken RPC.
`get_statement_of_financial_position` resolves every leg through `sofp_ledger_legs` and stamps
each line with `general_ledger trial balance — account <CODE>`, and all 22 accounts in
`ledger_account_catalog` have a valid `section` and `nature`. Every figure arrives correctly.

Classification happens entirely in the frontend file
`src/components/cfo/balanceSheetClassification.ts`, in three hardcoded lookup tables:

- `ASSET_ACCOUNT_MAP` — only A1, A2, A5, A3
- `LIABILITY_ACCOUNT_MAP` — only L4, L1
- `EQUITY_LABEL_MAP` — matches Retained Earnings by label only, no account codes

Any account code absent from those maps falls through `build()` into the flagged group.
So **A4, A9, L2, L3, L5, L6, L9, E1, E3, E4 are flagged simply because they were deliberately
left out of the maps** — the file's own comments state this was an intentional refusal to
guess. Nothing is lost: flagged lines are still included in the section total, which is why
the statement still foots (Assets 37,248,389 = Liabilities + Equity).

## Account-by-account findings (balances as at 01 Sep 2026, UGX)

| Code | Name | Balance | Why flagged | Recommendation |
|---|---|---|---|---|
| A4 | Advances and Other Receivables | (1,212,365,271) | Not in `ASSET_ACCOUNT_MAP`. One account mixes four things: `wallet_deduction_general_adjustment` (720M), `wallet_deduction` (512M), `agent_repayment` (25M), `rent_disbursement` (45M dr). Cannot be split into the separate "Agent" and "Employee" receivable lines the structure asks for without inventing the split. Also **credit balance in an asset account** — it is a net payable, not a receivable. | Do not force-map. Needs the account **split** into agent-advance vs employee-advance vs wallet-deduction-contra sub-accounts. Interim: map to `Other Assets` only if the CFO accepts a negative asset line. Investigate the credit balance separately. |
| A9 | Suspense — Unresolved Postings (debit) | 0 | Not mapped, by design. 2 legs (`orphan_reassignment` +1,000,000 / `orphan_reversal` −1,000,000) that net to zero. | **Legitimately unclassified.** Suspense is unresolved by definition. Currently zero, so it is also suppressed by `hasFlagged`. |
| L2 | Partner Portfolios — Capital Held | 7,468,856,396 | Not in `LIABILITY_ACCOUNT_MAP`, and there is no Balance Sheet category for it. `non_current_liability` section. Composition: `partner_funding` 6.64bn, `roi_reinvestment` 767M, `supporter_facilitation_capital` 57M. | **Needs a new category.** This is the single largest number on the statement and belongs on its own line, e.g. "Partner Capital Held" under a Non-Current Liabilities heading. Do not put it in Marketplace Liabilities. |
| L3 | Partner Returns / Rewards Payable | 0 | Not mapped and no matching category. **Zero legs** — the account exists in the catalog but nothing has ever posted to it. | Add a category when it starts carrying a balance. No action needed now. |
| L5 | Agent Commission Payable | 0 | Same as L3 — not mapped, no category, **zero legs**. Note `X3 Agent Commission Expense` carries 1.05bn, so commission is expensed and paid straight through the wallet (L1) without ever accruing here. | Needs a new "Agent Commission Payable" category only if accrual accounting is introduced. No action now. |
| L6 | Partner Top-Ups Awaiting Application | 94,180,234 | Not mapped, no category. 2,041 legs, all `pending_portfolio_topup`. | **Needs a new category** (or fold into the same Non-Current/Partner block as L2). Real money genuinely owed to partners, currently hidden in a flagged subtotal. |
| L9 | Suspense — Unresolved Postings (credit) | 0 | Not mapped, by design. **Zero legs.** | **Legitimately unclassified.** |
| E1 | Shareholders' Capital Contributions | 96,274,000 | Not mapped. The file's comment argues E1 is the general contributions account and equating it with the Angel Pool would misstate both. The data shows **`pool_capital_received` 94,155,000 (49 legs) + `share_capital` 2,119,000 (5 legs)** — so ~98% of E1 *is* Angel Pool. | **Map, with a caveat.** Either rename the category to "Shareholders' Capital Contributions" and map E1 to it, or split the 2.1M `share_capital` out so `Angel Pool Shares` stays truthful. Renaming the category is the cleaner fix. |
| E3 | Legacy Opening Balance Adjustments | (491,175,577) | Not mapped, no category. `historical_balance_reseed` 601M dr, `system_balance_correction` (85M), `balance_correction` (25M). | **Needs a new category**: "Legacy Opening Balance Adjustments" under Equity. It is a real, permanent equity contra — it will never resolve, so leaving it flagged means the flagged block never empties. |
| E4 | Legacy One-Sided Postings — Counterpart | (4,439,089) | Not mapped, no category. 9,480 legs, all `legacy_one_sided_counterpart` — the balancing side the RPC synthesises for historic one-sided groups. | **Map** to the same new "Legacy Opening Balance Adjustments" equity line as E3, or a sibling line. Same reasoning: structural and permanent. |

## Summary

- Legitimately unclassified: **A9, L9** (suspense, both zero).
- Dormant, no action: **L3, L5** (zero legs, no category needed yet).
- Map to an existing category: **E1** (to Angel Pool Shares, ideally after renaming that category, or after splitting out the 2.1M `share_capital`).
- Require **new** categories: **L2** (7.47bn), **L6** (94M), **E3** (−491M), **E4** (−4.4M).
- Requires an **account split**, not a mapping change: **A4** (−1.21bn), which additionally
  carries a credit balance in an asset account and warrants its own follow-up.

Roughly **UGX 7.06bn of liabilities and −495M of equity** are currently presented only inside
a flagged subtotal, purely for want of four category labels.

## If you want the fix

The whole change is confined to `src/components/cfo/balanceSheetClassification.ts`: add the
new category labels to `MARKETPLACE_LIABILITY_CATEGORIES`/a new non-current group and to
`EQUITY_CATEGORIES`, and add the corresponding code entries to `LIABILITY_ACCOUNT_MAP` and a
new equity code map. No migration, no RPC change, no recalculation — the numbers are already
correct and already in the totals. Say the word and I will plan that as a separate change.
