# Account catalogue

Every code in `ledger_account_catalog`, as at **2026-09-24**. A new code needs a
catalogue row with `section`, `nature` and `sort_order`.

⚠ marks an account with a documented defect — see `open-defects.md`.

---

## Current assets

| Code | Name | Notes |
|---|---|---|
| **A1** | Cash and Bank Balances | spendable now |
| **A2** | Cash at Hand — Float with Agents | ⚠ conflates a company asset with customer money |
| **A3** | Rent Access Receivables (Tenants) | the Rent Plan book |
| **A4** | Other Agent Receivables | ⚠ contaminated; excluded from receivables reporting |
| **A5** | Cash in Transit — Received, Not Yet Banked | |
| **A6** | Landlord Product Receivables | |
| **A7** | Partner Product Receivables | promissory notes; ties exactly to its subledger |
| **A8** | Agent and Merchant Float Cycle Control | float clearing |
| **A9** | Suspense — Unresolved (debit) | fallback for unmapped non-wallet legs |
| **A10** | Agent Advances Receivable | |
| **A11** | Agent Advance Access Fees Receivable | |
| **A12** | Merchandise and Smartphone Recovery Receivable | |
| **A13** | Bike Recovery Receivable | |
| **A14** | Credit Access Draws Receivable | |
| **A15** | Merchandise Credit Sales Receivable | redundant with A12/A13; retirement pending |
| **A16** | Service Centre Advances Receivable | |
| **A17** | Service Centre Receivables | |
| **A18** | Tenant Service Charge Receivables | |
| **A19** | Business Advance Receivables | |

## Liabilities

| Code | Name | Notes |
|---|---|---|
| **L1** | Wallet Custody Payable (user balances) | customer money; resolver-affected |
| **L2** | Partner Portfolios — Capital Held | non-current |
| **L3** | Partner Returns / Rewards Payable | ⚠ never used — zero legs ever |
| **L4** | Landlord Rent Payable | resolver-affected (synthetic debits) |
| **L5** | Agent Commission Payable | ⚠ nets to zero against a real obligation |
| **L6** | Partner Top-Ups Awaiting Application | |
| **L7** | Platform Treasury Control — Landlord Flow | deferred fee revenue |
| **L9** | Suspense — Unresolved (credit) | no legs |

## Equity, revenue, expense

| Code | Name | Notes |
|---|---|---|
| **E1** | Shareholders' Capital Contributions | |
| **E3** | Legacy Opening Balance Adjustments | |
| **E4** | Legacy One-Sided Postings — Counterpart | **resolver-injected only — never post to it** |
| **R1** | Platform Revenue | |
| **X1** | Operating Expenses | includes `marketing_expense`, `agent_bonus` |
| **X2** | Partner Returns Expense | |
| **X3** | Agent Commission Expense | |
| **X4** | Credit Losses and Write-offs | |
| **X5** | Reimbursement of Agent-Fronted Payouts | |
| **X6** | Float Restatement Adjustments | |

---

## Derived totals that matter operationally

| Figure | Formula | How to read it |
|---|---|---|
| **Total company cash** | A1 + A2 + A5 | includes cash physically held by agents |
| **Treasury cash** | A1 + A5 | `get_treasury_cash_position()` — **authoritative** |

`get_treasury_snapshot` is **superseded** and can show false negatives that look
like a deficit. Do not use it.

---

## Subledger ties

An account whose operational table can be summed independently. A tie that fails
is a real signal; a tie that holds is the cheapest integrity check available.

| Account | Subledger | Quality |
|---|---|---|
| **A7** | `promissory_notes` where `status='activated'` | **ties exactly — the best canary** |
| **A10** | `agent_advances.outstanding_balance` | |
| **A12 / A13** | `merchandise_recovery_plans.outstanding_balance` | |
| **A14** | `credit_access_draws.outstanding_balance` | |
| **L2** | `investor_portfolios.investment_amount` | ⚠ currently ~997M above active portfolios |
| **L1** | `wallets` withdrawable + locked | |

---

## Which accounts you may compute from `ledger_account_map`

| | Accounts |
|---|---|
| **Safe** — base mapping equals the resolver | A5, A6, A7, A11, A16–A19, L2, L3, L5, L6, L7, L9 |
| **Unsafe** — overrides and/or synthetics apply | A1, A2, A3, A4, A8, A10, A12–A15, L1, L4, E3, X4, X6 |

Computing an unsafe account from the map has produced wrong conclusions twice.
The single sanctioned exception is `get_treasury_cash_position()`, which
computes A1 and A5 from base mapping deliberately and is authoritative for those
two.
