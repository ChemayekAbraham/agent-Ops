# Float ⇄ withdrawable: what the money actually did, and the entry it needs

Read-only audit of the 625 `bucket_reclass_*` groups and the 356 `wallet_transfer` groups. Nothing was posted, changed or deployed.

## What these transactions are

Every one of the 981 groups has **exactly two legs, both inside wallets, and no platform leg at all**. There is no bank leg, no treasury leg, no cash receipt, no payment. One bucket of a wallet goes down and another bucket goes up by the identical amount, on the same day.

The sources name themselves: `finops_wallet_move`, `admin_float_to_withdrawable`, `admin_withdrawable_to_float`, `agent_withdrawable_to_float`. These are Finance and admin staff moving money between an agent's spending float and the agent's own withdrawable balance. They are not sales, not collections, not payouts.

Measured populations:

| Movement | Groups | Amount |
|---|---|---|
| Float → withdrawable | 642 | 1,514,268,576 |
| Withdrawable → float | 339 | 311,745,740 |
| Net shift into withdrawable | | 1,202,522,836 |

Supporting traces: 194 groups (352,258,781) had the float sitting there in full; 34 (171,146,315) partly; **414 (990,863,480) had no float in the wallet at all** — the move pushed float negative instead. Wallets involved were later paid out in real cash, so the withdrawable side is a genuine claim.

## The key finding

In every case **the total the company owes that wallet does not change**. Float down 100, withdrawable up 100 — the wallet holds the same amount, only the label changes from "you may spend this on company business" to "you may withdraw this".

So:

- It is **not** a new expense.
- It is **not** income.
- It is **not** a payment or a receipt.
- It **is** an internal reclassification of an obligation the company already had.

This holds whether or not the float was really there beforehand, because both sides are mirrors of the same wallet.

**The 2× X4 expense treatment applied this morning is therefore not economically supported.** It books UGX 2,405,045,672 of cost for events that cost nothing. It arose only because both real legs are credits once the withdrawable side is treated as money owed — that is a signal the float side is mislabelled, not evidence of an expense.

## Why the requested constraints cannot all hold as stated

You asked for A2 correct, L1 correct, A8 out of it, balanced, no invented expense. That set is unsatisfiable **while float is carried as a company asset**, because both legs then move the same way and something has to absorb 2× the amount — either A8, or an expense, or an asset that does not exist.

The resolution is upstream: money in an agent's float bucket is money the company owes that agent, exactly like withdrawable — it is simply restricted in how it may be used. Read that way, float is part of the same custody obligation, and every constraint holds at once.

## Confirmed treatment and entries

Float → withdrawable, amount X:

```text
Dr  Float custody (restricted)      X      obligation released from float
Cr  L1 Withdrawable custody payable X      obligation now payable on demand
```

Withdrawable → float: the same entry reversed. No expense, no income, no cash, A8 untouched, balanced by construction.

Effect on the statement, against today's live figures:

| Line | Now | After |
|---|---|---|
| L1 customer money held | 1,407,950,648 Cr | 1,407,950,648 Cr (unchanged) |
| X4 cost | 2,871,702,707 Dr | 466,657,035 Dr (the 2,405,045,672 reversed out) |
| A8 float control | 2,240,539,682 Cr | unchanged |
| Restricted float custody | — | 1,202,522,836 Cr moved out of the float asset line |

L1 lands on the same number it shows now; the difference is that the balancing side becomes a reclassification inside customer money rather than an invented cost.

## Partner funding — the proposed A2 mapping is not confirmed

171 legs, UGX 371,420,964 (net 368,320,964), 147 users; 92 of them are preceded within seven days by the agent depositing their own cash. The agent's float is the route through which a partner's cash reaches a portfolio.

Each group has only two legs: the float reduction, and the partner obligation (L2). Mapping the float leg to A2 leaves both legs as credits and puts UGX 736,641,928 out of balance — which is why it was reverted earlier today. The missing side is the **partner's cash received**, not a float asset and not customer custody. Until that cash leg is agreed, no mapping change to this category is safe.

## Decision needed from you

Whether float is an obligation to the agent (restricted customer money) or an asset of the company. Everything above follows from the first reading; if you hold the second, the only arithmetically available answers are an A8 plug or a real expense, and I will not pick between those on your behalf.

## Smallest reporting-side correction, if you confirm

1. Reverse this morning's X4 counterpart legs — drop the `synth_reclass` block, so 2,405,045,672 of cost disappears.
2. Give the float side of these three categories only (`bucket_reclass_in`, `bucket_reclass_out`, `wallet_transfer`) a restricted-custody presentation, so a float decrease releases an obligation instead of writing off an asset.
3. Keep the withdrawable side in L1 as it now is (the `debit_when` change already applied is correct and stays).
4. Leave the narrowed A8 rule as applied, so nothing else changes behaviour.
5. Re-measure L1, A2, A8, X4 and the debits-equals-credits check; the pre-existing 13,000,000 discrepancy stays out of scope.
6. No `general_ledger` row, wallet balance, bucket, or repayment figure is touched. Partner funding stays untouched pending the cash-leg question.

## Technical notes

- Population: `general_ledger` wallet legs, `wallet_bucket = 'withdrawable'`, categories `bucket_reclass_in` / `bucket_reclass_out` / `wallet_transfer`, in groups that also carry a float leg; classification `production` / `legacy_real`.
- Group shape is uniformly two wallet legs, `n_plat = 0` — verified across all 981 groups.
- Float provenance for the wallets involved: `agent_float_deposit` from `merchant_float_reconciliations` (46.78bn), `deposit_requests` (1.49bn) and `cfo_direct_credit` (979m) — i.e. predominantly cash the agent or merchant put in, recorded Dr A2 / Cr A8.
- Change 3 to implement: remove the `synth_reclass` CTE from `public.sofp_ledger_legs` and resolve the float leg of the three categories to a restricted-custody account instead of A2, leaving the narrowed A8 branches and all other categories exactly as they are.
- `ledger_account_map` rows for `bucket_reclass_in/out` + `withdrawable` + `L1` keep `debit_when = 'cash_out'`.
