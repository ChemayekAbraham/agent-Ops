# Why the CFO Balance Sheet does not balance — 15 Aug 2026

Read-only investigation. No data was changed, no backfill, no sweep.

## Measured position (as at today)

| Line | UGX |
|---|---|
| Total Assets (approx., per the report's own formula) | 839,767,746 |
| Total Liabilities | 7,589,444,557 |
| Total Equity | (5,603,579,449) |
| Total Liabilities + Equity | 1,985,865,108 |
| **Difference (Assets − L&E)** | **(1,146,097,362)** |

Component figures: Cash at Bank (platform ledger net) 181,891,754 · Cash at Hand (float) 41,638,756 · Rent Access Receivables 288,675,739 · Wallet custody liability 357,781,364 · Partner Portfolios 6,867,021,254 · Revenue-to-date 4,061,500 · Expenses-to-date 5,703,585,949 → Retained (5,699,524,449).

## Root causes

1. **Retained earnings is built from a category allowlist, Cash at Bank is not.**
   `get_statement_of_financial_position` nets **every** platform ledger leg into Cash at Bank, but recognises revenue/expense from only 16 hard-listed categories. The excluded platform volume dwarfs the included volume:
   `partner_funding` 6.22B in, `agent_float_deposit` 2.31B out, `pending_portfolio_topup` 2.01B in / 1.96B out, `wallet_withdrawal` 2.00B in, `wallet_deposit` 1.58B out, `agent_float_settlement` 1.03B in, `wallet_deduction_general_adjustment` 720M, `roi_reinvestment` 639M, `historical_balance_reseed` 602M, `rent_disbursement` 598M, `wallet_deduction` 514M, `wallet_transfer`, `salary_payout`, `agent_landlord_payout`, `listing_rejection_recovery`, `agent_repayment`…
   Anything in that list moves cash (asset side) but is credited to neither a liability nor equity. This alone makes balancing impossible.

2. **Two sources of truth are mixed.** Cash at Hand, wallet custody, and advance liability are read from the `wallets` cache, while Cash at Bank is read from `general_ledger` **platform scope only**. The wallet-scope legs that create those balances are excluded from the asset side, so 357.8M of custody liability + 41.6M float have no articulating ledger asset.

3. **Receivables come from operational sub-ledgers that never posted a receivable leg.** `rent_requests` (288.7M), `agent_advances`, `merchandise_sales`, `promissory_notes`, `welile_homes_*`, `credit_access_draws`, `business_advances` are summed straight off their own tables. In double-entry terms these are debits with no credit anywhere in the ledger.

4. **Deployed partner capital is asymmetric.** Partner Portfolios (6.87B) is recognised as a liability at face value, while the capital that was deployed out (rent disbursements, pool deployments, float) leaves cash and lands in receivables tracked outside the ledger, or in expense categories that are not in the P&L allowlist.

5. **Mirror lines misstate both sides (net-zero on the check, wrong on the face).** Partners' Compounding ROI is presented as an asset *and* as ROI Payable; Share Receivables is presented as a non-current asset *and* inside equity. They cancel in the difference but overstate assets, liabilities and equity.

6. **`GREATEST(x, 0)` clamps every line.** Overdrawn wallets, over-collected rent plans and negative outstanding balances are silently dropped, so the asset side loses value that the liability side keeps.

## What would make it balance (reporting layer only, not done here)

- Derive **both** Cash and Retained Earnings from the same ledger set: classify every platform category exactly once as asset/liability/equity/revenue/expense (a ledger category → balance-sheet map), instead of an allowlist plus a catch-all cash net.
- Include wallet-scope legs on the asset side (or exclude wallet buckets from liabilities) so custody articulates.
- Recognise sub-ledger receivables only to the extent a matching `rent_receivable_created`-style bridge leg exists, and disclose the unposted remainder as a reconciling line rather than folding it into totals.
- Remove the two mirror lines, and report negatives rather than clamping them.
- Keep the Balance Check honest — surface the reconciling items explicitly; never plug the difference.
