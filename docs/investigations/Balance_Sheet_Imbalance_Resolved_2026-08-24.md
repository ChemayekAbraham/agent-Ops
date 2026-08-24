# Balance Sheet imbalance of UGX 1,418,166,833 — traced and resolved (24 Aug 2026)

Reporting-layer fix only. **No ledger row was created, altered, deleted or reclassified.**
No suspense plug, no hard-coded offset, no hidden difference.

## Position before

| Line | UGX |
|---|---|
| Total Assets | 341,639,977 |
| Total Liabilities + Equity | 1,759,806,810 |
| **Unexplained difference** | **1,418,166,833** |

## Root cause

Not missing money. 1,114 transaction groups were **balanced in the ledger**
(`sum(cash_in) = sum(cash_out)`) but the reporting map put **both legs on the same side** of the
trial balance, so they never articulated. Two defects:

1. `ledger_account_map` is keyed on `(ledger_scope, category, wallet_bucket)` only, while several
   categories carry **two opposite economics depending on the originating workflow**
   (`source_table` / the shape of the group).
2. `platform.system_balance_correction` was mapped to the suspense asset `A9` with the **opposite
   `debit_when`** of its sibling `platform.balance_correction` (`E3`).

Drivers, largest first:

| Workflow | Groups | Residual (UGX) |
|---|---|---|
| Float → withdrawable reclass (`admin_float_to_withdrawable`) | 284 | −1,390,152,722 |
| Admin balance corrections (`finops_wallet_move`, `cfo_direct_credit`, wallet transfers) | 203 | +212,807,054 net (≈1.06bn gross) |
| Withdrawals settled out of agent float | 21 | −103,770,000 |
| Agent advances disbursed into wallets | 348 | −70,846,022 |
| 25 smaller signatures of the same class | 108 | −179,131,372 |

## What was changed (reporting layer)

`sofp_ledger_legs(as_at)` is now the single resolver used by
`get_statement_of_financial_position(as_at)`. It applies the base map, then these documented rules
(CFO-approved 24 Aug 2026):

| Rule | Treatment |
|---|---|
| R1 | `platform.system_balance_correction` → `A1` when the group touches agent float (cash genuinely returned to / paid by the platform), otherwise `E3` equity adjustment, matching `platform.balance_correction`. |
| R2 | `platform.rent_disbursement` from `agent_advance_requests` → `A4` advance receivable (debit), not bank cash out. |
| R3 | `platform.wallet_deduction` in a group with a float leg and no custody leg → `A1` (float swept back to platform cash). |
| R4 | `platform.wallet_withdrawal` in a group with wallet legs but **no** custody (`L1`) leg → the leg *is* the custody settlement (debit `L1`); no second bank payment is recognised. |
| R5 | Float ⇄ withdrawable reclass (2 wallet legs, one `A2`, one `L1`): the user-side leg is recognised as a **cost to the company** in `X4`. Approved treatment: the float released into a user's own balance is expensed; the resulting user balance stays visible in the wallet-cache memo line rather than being counted a second time as custody. |
| R6 | Rent collected by an agent into float (group contains `tenant_repayment` / `rent_repayment`) → the float leg is cash received (debit `A2`). |
| R7 | Platform fees paid out of float (group contains revenue `R1`) → the float leg is cash received (debit `A2`). |
| E4 | Historic **one-sided** postings (the counterpart was never recorded: 9,480 groups, net −4,439,089) are recognised in the new, explicitly labelled equity account **E4 “Legacy One-Sided Postings — Opening Balance Counterpart”** and itemised by category in the reconciliation schedule. |

## Position after

| Line | UGX |
|---|---|
| Total Assets | 369,120,903 |
| Total Liabilities + Equity | 369,120,903 |
| **Difference** | **0** |
| Total debits / credits | 29,279,586,537 / 29,279,586,537 (difference 0) |

Zero balanced transaction groups remain mismapped. Every group in the reconciliation schedule is a
genuinely one-sided historic posting, listed by scope and category.

## Effect on other reports (verified)

| Account | Before | After | Why |
|---|---|---|---|
| A9 Suspense | 282,898,959 | 0 | corrections reclassified to A1 / E3 |
| A1 Cash and Bank | 78,227,555 | 338,974,594 | corrections and float sweeps that returned cash are now debited to cash |
| A2 Float with agents | 327,291,919 | 339,960,953 | collections and fees received into float now debit float |
| A4 Advances receivable | (1,258,082,798) | (1,221,118,986) | advance disbursements now debit the receivable |
| L1 Wallet custody | 1,225,716,895 | 510,254,045 | float→withdrawable amounts no longer double-counted; float-settled withdrawals now reduce custody |
| X4 Credit losses / write-offs | 465,473,700 | 1,264,019,475 | approved cost recognition on float released to user balances |
| E3 Legacy opening adjustments | (601,985,884) | (474,224,077) | corrections reclassified out of suspense |
| A3, A5, L2, L6, E1, R1, X1, X2, X3 | — | unchanged | untouched by the rules |

Revenue to date (11,348,412) is unchanged, and X1/X2/X3 are unchanged, so the Income Statement moves
only by the approved X4 write-off. `get_statement_of_cash_flows` and the CFO dashboard cash widgets
read their own functions and were not modified.

## Open item (pre-existing, not caused by this fix)

`A4 Advances and Other Receivables` carries a **credit** balance of (1,221,118,986): historically more
advance-related legs credit A4 than debit it, because most advance receivables were never posted to
the ledger (they live in the operational sub-ledgers shown in the memo lines). Closing that requires
posting genuine receivable debits per advance — a money-movement decision for CFO sign-off.
