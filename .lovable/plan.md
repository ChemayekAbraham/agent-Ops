# Restructure Liabilities on the CFO Balance Sheet

Regroup the Liabilities side of the CFO Dashboard → Balance Sheet panel into two business categories with their own subtotals and one consolidated Total Liabilities. This is a presentation change only: every figure keeps coming from the same ledger-driven statement, and no accounting, mapping or posting logic is altered.

## What changes on screen

```text
LIABILITIES
  Marketplace Liabilities
    Landlord Float — Company Managed
    Landlord Float — Self Managed
    Partner Buffer Liability
    Subtotal — Marketplace Liabilities

  Operational & Other Liabilities
    Operational Float Liability
    Wallet Bucket Liability
    Merchant Agent Liability
    Other Payables
    Subtotal — Operational & Other Liabilities

  TOTAL LIABILITIES
```

The existing "Current Liabilities / Non-Current Liabilities" headings and their two subtotals are removed from this panel, as agreed. Total Liabilities, the Assets side, Equity, the balance check and the trial balance are untouched.

## Where the numbers come from

The panel calls the statement function, which returns liability lines sourced from the reporting chart of accounts. Today those lines are:

| Account | Line returned today |
| --- | --- |
| L1 | Wallet Custody Payable (user balances) |
| L2 | Partner Portfolios — Capital Held |
| L3 | Partner Returns / Rewards Payable |
| L4 | Landlord Rent Payable |
| L5 | Agent Commission Payable |
| L6 | Partner Top-Ups Awaiting Application |
| L9 | Suspense — Unresolved Postings |

Proposed grouping of those same account balances into the seven requested lines:

| New line | Fed by |
| --- | --- |
| Landlord Float — Company Managed | L4 Landlord Rent Payable |
| Landlord Float — Self Managed | Partner self-support house float (see note below) |
| Partner Buffer Liability | L2 Partner Portfolios — Capital Held + L6 Partner Top-Ups Awaiting Application |
| Operational Float Liability | Float-bucket obligation legs (see note below) |
| Wallet Bucket Liability | L1 Wallet Custody Payable |
| Merchant Agent Liability | Merchant out-of-pocket / agent settlement obligations |
| Other Payables | L3 Partner Returns / Rewards Payable, L5 Agent Commission Payable, L9 Suspense, and any liability account not named above |

Two honest caveats, both confirmed by inspecting the live ledger:

- **Landlord Float — Self Managed** has no ledger legs yet — the partner self-support house funding flow has not posted a single entry, and its category has no reporting-account row. The line will render as zero until that flow is used; it will start populating automatically once the account mapping row exists. Adding that mapping row is included as an optional follow-up, not silently assumed.
- **Operational Float Liability** and **Merchant Agent Liability** currently resolve to asset/receivable accounts (agent float is an asset; merchant out-of-pocket is a receivable), so on the liability side they are expected to be zero or near-zero today. They are still rendered so the structure is complete and starts reporting the moment a liability-side balance exists.

## Correctness guarantee

Grouping is keyed by account code with a catch-all: any liability account not explicitly named lands in **Other Payables**. This makes it mathematically impossible for a balance to disappear from the statement. The panel will also assert that

`Marketplace subtotal + Operational & Other subtotal = Total Liabilities`

and show an inline warning if they ever diverge, in the same style as the existing balance check.

## Technical notes

- Single file touched: `src/components/cfo/BalanceSheetPanel.tsx`.
- Add a grouping helper that reads the account code out of each line's `source` string (`... — account L4`) and buckets the line; unknown codes fall through to Other Payables. No database change, no change to `get_statement_of_financial_position`, `sofp_ledger_legs`, `ledger_account_catalog` or `ledger_account_map`.
- Apply the same two-category structure to the CSV export and the PDF export so on-screen, CSV and PDF agree line for line.
- Amounts, sign conventions, the as-at date picker, source drill-downs, the reconciliation schedule and memo sub-ledgers all stay as they are.
