# Financial statement audit — findings so far, and the checks still to run

Read-only throughout. Nothing below changes data, code or the ledger.

## What I could already confirm from the ledger

**1. The Balance Sheet's "it balances" tick is not evidence of correctness.**
Every ledger leg is turned into either a debit or a credit, and legs whose transaction has
no matching opposite side are absorbed into an equity line ("Legacy One-Sided Postings —
Opening Balance Counterpart"). So Assets = Liabilities + Equity comes out to zero
difference by construction, whatever the underlying data says.

Measured on real (production + legacy) entries:

| Item | Count | Amount (UGX) |
|---|---|---|
| Transactions with only one side | 13,166 | — |
| Transactions that do not balance | 13,188 | 1,642,763,960 absolute |

Largest one-sided groups: partner/agent wallet transfers (420m), Returns payouts (307m),
wallet deposits (233m), agent float assignment (194m), a write-off group (143m), a
historical balance reseed (143m).

**2. Cash Flow measures a narrower "cash" than the Balance Sheet shows.**
The Cash Flow treats cash as only two accounts: Cash at Bank and Agent Float. It ignores
Cash in Transit (received, not yet banked) and the Agent/Merchant Float Cycle Control
account — both live and material. Closing cash on the Cash Flow therefore cannot tie to the
cash lines now presented on the Balance Sheet.

**3. Many movements fall into an unclassified catch-all on the Cash Flow.**
The classification table has no rows at all for Agent Float, Cash in Transit, Float Cycle
Control, Agent Commission Payable, Treasury Control, and several expense accounts. Anything
against them lands on "Other Operating Activities → Unclassified ledger movements" instead
of a real line.

**4. The Income Statement uses a second, independent mapping.**
Revenue and expenses are grouped in application code from hand-maintained category lists,
not from the same chart of accounts the Balance Sheet uses. Two mappings for one ledger is a
standing drift risk; several sizeable, newer categories need confirming against both
(treasury fee recognised, verified bank cash recognised, agent float cash offset, partner
capital cash received, cash receipt in transit, cash custody payable, landlord receivable
obligation, treasury fee drawdown).

**5. Different exclusion basis between statements.**
The Balance Sheet admits one class of correction entries (merchant float restatements) that
the Cash Flow excludes entirely, so the two statements are not drawn on the same population.

**6. Possible duplicate legs.** 76 cases where the same transaction carries an identical
category, direction and amount more than once — UGX 4,156,000 in total. Small, but each
needs eyeballing to confirm it is a genuine split rather than a double post.

## What I could not do from here

The three statement functions are permission-gated, so I could not pull the actual reported
figures with my query access — only the underlying ledger. To tie reported numbers to the
ledger I need to read the statements as they render for a CFO user.

## Remaining checks (all read-only)

1. Open the CFO Financial Reports as a CFO and capture the Balance Sheet, Income Statement
   and Cash Flow figures for the same period.
2. Tie each Balance Sheet line to an independently recomputed trial balance per account, and
   quantify how much of Equity is the one-sided-postings counterpart.
3. Confirm Cash at Bank against the verified banking declarations, and restate the
   previously disclosed variance.
4. Tie Income Statement revenue and expenses to the same ledger accounts the Balance Sheet
   uses, list every category counted twice, counted nowhere, or sitting in the review queue,
   and quantify each.
5. Tie Cash Flow opening + net = closing, and closing cash to the Balance Sheet cash
   accounts; quantify the amount sitting in the unclassified catch-all and what it consists
   of.
6. Review the 76 possible duplicates and the largest one-sided groups by source, and state
   for each whether it overstates or understates a specific line.

## Deliverable

One written audit note per statement — figure, ledger support, and any overstatement,
understatement, missing entry, duplicate or reporting-only figure, each with an amount.
No fixes proposed in it; correction work would be a separate, separately approved task.

## Technical notes

Verified: `general_ledger` group balance and one-sided populations; `sofp_ledger_legs` and
`get_statement_of_financial_position` bodies (E4 absorption, rules R1–R7); `ledger_account_map`
defaults for wallet legs; `ledger_account_catalog` (A1–A9, L1–L9, E1–E4, R1, X1–X6);
`get_statement_of_cash_flows` cash basis `('A1','A2')` and its LATERAL match against
`cash_flow_line_map`; `src/lib/incomeStatementServiceMap.ts` revenue/marketing/operating/
non-P&L lists and `src/hooks/useFinancialStatements.ts` platform-scope netting.
