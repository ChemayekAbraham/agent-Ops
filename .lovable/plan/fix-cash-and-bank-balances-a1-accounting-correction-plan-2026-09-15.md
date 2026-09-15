# Fix Cash and Bank Balances (A1) — accounting correction plan

Read-only investigation complete. Nothing has been changed. All figures are "as at now" over the
live append-only ledger, so they move slightly between runs.

## Where the figure comes from today

`Statements → Balance Sheet` calls `get_statement_of_financial_position`, which reads
`sofp_ledger_legs` (the resolver that maps each ledger leg to a reporting account via
`ledger_account_map` plus rules R1–R8). The screen then groups A1 + A2 + A5 into one
"Cash and Bank Balances" line.

Current: A1 (693,896,824) · A2 114,655,878 · A5 567,557,552 → displayed (167,848,418).
Independently verified company bank position: 1,310,690,843.

## What is actually wrong (measured, by pattern)

| # | Pattern | Legs | Net effect on A1 | Why it is wrong |
|---|---|---|---|---|
| P1 | Merchant/agent desk float re-set to an evidenced figure (`merchant_float_reconciliations`: `agent_float_deposit` production pair + `system_balance_correction` admin pair, 46.8bn gross each way) | 332 | (128,004,746) | No bank money moves. A desk-float restatement is being posted as bank cash in and out. It is also the only reason `admin_correction` rows enter the statement at all (resolver exception). |
| P1b | Other float-related `system_balance_correction` legs pulled to A1 by rule R1 (`finops_wallet_move`, etc.) | 71 | 189,940,717 | Same defect in the opposite direction: manual float moves credited to bank. |
| P2 | Float issuance / top-up / settlement (`agent_float_deposit`, `agent_float_settlement`, `agent_float_funding`, `agent_float_assignment`, `agent_float_topup`) mapped to A1 | 15,533 | (1,735,790,637) | Float is an allowance / amount due from agents, not a bank withdrawal. These belong to a float control account, not to bank cash. |
| P3 | 218 deposits declared and verified as banked, UGX 1,539,592,843, of which only 109,420,000 was ever posted as a bank event | — | 0 today | 1,430,172,843 of confirmed banked cash raises no bank asset. It currently sits in A5 custody (564,324,000), A2 float (706,228,444) or was booked straight to A1 as a wallet deposit (495,022,399). |
| P4 | Presentation: A2 (float, not cash) and A5 (custody, not banked) folded into the same line as bank | — | — | Breaks the standing policy that custody and float are shown separately. |

Remaining genuine A1 activity, after excluding P1/P1b/P2: **979,957,842** (wallet deposits and
withdrawals, partner capital received, rent disbursements, treasury bank deposits, transfers).

## Proposed correction

Nothing in `general_ledger` is rewritten. Existing legs are re-mapped in the resolver; only the
missing bank-recognition events are posted as new, balanced, idempotent entries.

### Step 1 — Two new reporting accounts (no plug, both fully articulated)

- `A8 Agent and Merchant Float Control` (current asset) — the counterpart of float issuance and
  settlement, so float movements never touch bank.
- `X6 Float Restatement Adjustments` (expense) — the counterpart of desk-float re-sets to an
  evidenced figure, shown openly on the income statement instead of hidden in bank.

### Step 2 — Re-map the wrong patterns (resolver only)

| Pattern | Moves from | Moves to | Journal shape after fix |
|---|---|---|---|
| P1 desk float re-set (increase) | A1 | X6 | DR A2 float · CR X6 |
| P1 desk float re-set (decrease) | A1 | X6 | DR X6 · CR A2 float |
| P1b float `system_balance_correction` | A1 | X6 | as above |
| P2 float issued to an agent | A1 | A8 | DR A2 float · CR A8 |
| P2 float settled / swept back | A1 | A8 | DR A8 · CR A2 float |

Rule R1's "A1 when the group touches float" branch is narrowed so it can no longer route float
corrections into bank; `ledger_account_map` rows for the five float categories in `platform` scope
point to A8. Tenant-payment postings from correction 0114 (DR A5 / CR A3) are untouched.

### Step 3 — Recognise verified banked cash into A1

One new posting per verified banking declaration, keyed on the verification id (idempotent, cannot
double-post), through a SECURITY DEFINER RPC. The counterpart is chosen from the deposit's own
existing legs — never invented:

| Deposit currently sits in | Journal | Amount |
|---|---|---|
| A5 custody, still unbanked | DR A1 · CR A5 | up to 564,324,000 |
| A2 float with the agent | DR A1 · CR A2 | up to 706,228,444 |
| Already debited to A1 as a wallet deposit | no entry — already recognised | 495,022,399 |

Any declaration whose counterpart cannot be identified leg-by-leg is **not** posted; it is listed
in a reconciliation schedule for Financial Ops. No aggregate top-up, no plug.

### Step 4 — Presentation

"Cash and Bank Balances" shows A1 only. A2 float, A5 "Cash in Custody — Not Yet Confirmed Banked"
and A8 float control become their own lines under current assets, and A1 gets a memo line comparing
it with the verified bank reference.

## Expected outcome

| Line | Now | After |
|---|---|---|
| A1 Cash and Bank | (693,896,824) | 979,957,842 + recognised banked cash, target ≈ 1,310,690,843 with any unmatched declarations disclosed, not plugged |
| A2 Float with agents | 114,655,878 | reduced by float banked in Step 3; float control A8 shown alongside |
| A5 Cash in Custody | 567,557,552 | reduced only by its own banked declarations, still a separate line |
| Displayed "Cash and Bank Balances" | (167,848,418) | A1 alone |

Double-entry integrity: every step above is a two-sided move. Steps 1–2 relocate an existing debit
or credit between accounts, so total debits and total credits are unchanged. Step 3 posts balanced
pairs only. Assets = Liabilities + Equity therefore continues to hold with zero difference and no
suspense line; the check is re-run and reported before and after each step.

## Out of scope, explicitly untouched

Banking-control workflow, Equity email parser, the 184 historical "banked" declarations as records,
the tenant-payment custody correction (0114), commission logic, and all wallet balance behaviour.

## Verification before anything is called done

1. Trial balance: total debits = total credits.
2. Assets = Liabilities + Equity, difference 0, no suspense/plug account used.
3. A1 vs verified bank reference reconciles, with each residual item itemised.
4. A5 reconciles to `cash_receipt_in_transit` less `cash_in_transit_banked` (currently exact).
5. Income statement lines R1/X1/X2/X3 move only where X6 is intended to appear.
6. Re-post-safety: running Step 3 twice creates no second entry.

## Technical notes

New accounts are added to `ledger_account_catalog` / `ledger_account_map`; the resolver change is
confined to `sofp_ledger_legs`; Step 3 adds one RPC that posts through the existing ledger
transaction path (frontend posts nothing). Grouping change is in
`src/lib/balanceSheetClassification.ts` and `BalanceSheetPanel.tsx`.
