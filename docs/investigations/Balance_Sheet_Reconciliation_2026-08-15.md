# Balance Sheet / General Ledger reconciliation — 15 Aug 2026

No transaction, wallet, reconciliation or money-movement logic was changed. No ledger row was
created, deleted or duplicated. Everything below is a reporting-layer change plus a disclosure
schedule of what still cannot be resolved safely.

## What was wrong

1. Cash was the catch-all: `get_statement_of_financial_position` netted **every** platform ledger
   leg into "Cash at Bank" while recognising revenue and expenses from a 16-category allowlist.
   Everything outside the allowlist moved cash with no liability, equity, revenue or expense credit.
2. Two sources of truth: cash came from the ledger, custody / float / advance liabilities from the
   `wallets` cache, receivables straight from operational tables (rent plans, advances, merchandise,
   promissory notes) that had never posted a receivable leg — debits with no credit anywhere.
3. Mirror lines (compounding ROI as both asset and payable, share receivables as both asset and
   equity) and `GREATEST(x,0)` clamping distorted every subtotal.

## What was built

- `ledger_account_catalog` — the reporting chart of accounts (A1 cash, A2 float with agents,
  A3 rent receivables, A4 advances/other receivables, L1 wallet custody, L2 partner portfolios,
  L6 partner top-ups, E1 capital, E3 legacy opening adjustments, R1 revenue, X1–X4 expenses,
  A9/L9 suspense).
- `ledger_account_map` — one row per (ledger scope, category, wallet bucket) saying which account
  the leg belongs to and which cash direction is its debit side. Platform mirror legs are recorded
  inverted for deposits, withdrawals, transfers and wallet deductions, so the map states that
  explicitly instead of guessing from the sign.
- `sofp_ledger_legs(as_at)` — read-only helper that turns each ledger leg into a debit or a credit.
- `get_statement_of_financial_position(as_at)` — rebuilt as a trial balance over those legs.
  Operational tables and wallet caches no longer feed any total; they appear as memo comparisons
  (rent plans, agent advances, business advances, credit draws, merchandise, promissory notes,
  `investor_portfolios` vs L2, wallet cache vs L1/A2, landlord payouts vs L4).
  Retained earnings is now revenue accounts less expense accounts from the same leg set that
  produces cash, so the two sides articulate.

Result: Total Debits = Total Credits and Total Assets = Total Liabilities + Equity with a zero
difference on the face of the statement, because the residual of the one-sided historic postings is
carried in a single, labelled suspense line and itemised in the schedule — it is not spread across
real accounts and no plug was posted to the ledger.

## What could NOT be resolved safely (reported, not guessed)

13,007 transaction groups carry only one side of their entry, UGX 5.69bn in absolute terms,
netting to roughly UGX 4.17bn held in suspense. The material buckets:

| Item | Amount | Why it cannot be closed automatically |
|---|---|---|
| Pre-ledger partner funding (`platform.partner_funding`, single leg) | ~2.55bn | The capital was received before the ledger existed. The missing debit is either bank cash or an opening-balance equity entry; only the CFO can say which, per funding batch. |
| Float → withdrawable reclassifications (`wallet.agent_float_assignment` + `wallet.wallet_transfer`, 279 groups) | ~1.06bn | Both legs are credits: company float was converted into an amount owed to an agent with no expense, commission or receivable debit recorded. |
| `historical_balance_reseed` / `balance_correction` (legacy) | ~1.07bn credited to wallets vs 602m debited | Legacy reseeds of wallet balances. Presented in equity as "Legacy Opening Balance Adjustments"; the unmatched remainder needs a CFO-approved opening-balance decision. |
| `system_balance_correction` and other `admin_correction` / `test_dev` classifications | ~1.09bn | Deliberately outside the statement; disclosed under excluded classifications. |
| Advances credited to wallets with no receivable leg (`agent_advance_credit`, `rent_disbursement` pairs, 267 groups) | ~63m | The advance receivable was never posted; the sub-ledger holds it (see memo lines, ~328m across sub-ledgers). |
| Withdrawals settled from float (`wallet_withdrawal` + `agent_float_used_for_rent`, 21 groups) | ~104m | The custody debit is missing; which wallet bore it must be confirmed case by case. |

Closing these requires posting genuine counterpart legs (opening-balance equity for pre-ledger
capital, receivable debits for advances, expense/commission debits for float reclassifications).
That is a money-movement decision, so it is left for CFO sign-off rather than assumed here.
