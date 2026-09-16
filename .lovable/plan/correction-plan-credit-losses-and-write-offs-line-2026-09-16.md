# Correction plan — "Credit Losses and Write-offs" line

Scope: the write-off line on the Income Statement / Balance Sheet only. Presentation and
mapping only — no ledger entries, no historical data changes, no new money movement.
Nothing is implemented until this plan is approved.

## What is wrong

The line currently reports UGX 1,808,675,065. Only UGX 466,657,035 of it is a real
write-off. The rest is money being moved between an agent's float and their withdrawable
balance — a reclassification that changes nothing the company owns or owes, and is not a cost.

Measured on live data as at today:

| What sits in the line | Amount | Is it a loss? |
|---|---|---|
| Genuine write-offs (`platform_loss_writeoff`) | 466,657,035 | Yes |
| Float ⇄ withdrawable reclass (`bucket_reclass_in` less `bucket_reclass_out`) | 613,475,755 | No |
| Wallet transfers (`wallet_transfer`) | 681,478,775 | No |
| Wallet deposits mis-landing here (`wallet_deposit`) | 50,100,000 | No |
| Small residue (`manager_credit`, commission-used-for-rent, one withdrawal) | −3,039,500 | No |
| **Non-loss total** | **1,342,015,030** | |

Cause: in the reporting resolver `sofp_ledger_legs`, a two-legged wallet group made of one
float leg and one withdrawable leg has its withdrawable side forced into the write-off account
so the group balances. That single rule produces the whole 1.34bn. The write-off *account
mapping itself* is clean — it maps only `platform_loss_writeoff`.

Consequence today: the Income Statement and the Balance Sheet disagree by ≈ 1,523,977,000,
because the Balance Sheet expenses these reclassifications and the Income Statement does not.

## The correction

1. In `sofp_ledger_legs`, replace the "force the withdrawable leg into write-offs" rule for
   float ⇄ withdrawable groups. The offsetting side moves to **A8 Agent Float Cycle Control**,
   an existing balance-sheet control line already disclosed separately. Result: the movement
   stays on the balance sheet between float, wallet custody and the float control line, and
   leaves profit or loss entirely.
2. Leave the write-off line containing `platform_loss_writeoff` only, so it reads
   **466,657,035**.
3. Do not touch: the general ledger, historical entries, tenant repayment posting, Treasury,
   the banking-control workflow, the Equity email parser, cash and bank classification, or any
   other statement line.

Optional, same family — say if you want them included:

- Align the UGX 189,940,717 of float restatements (X6) so both statements treat them the same
  way. Today the Balance Sheet expenses them and the Income Statement does not.
- Align the UGX 8,876,000 of listing incentive recoveries, which are revenue on one statement
  and non-P&L on the other.
- Classify the two unmapped treasury categories (`agent_float_cycle_settled_to_bank`,
  `verified_bank_cash_recognised`, 574,518,888) explicitly as non-P&L treasury routing so the
  review queue empties.

## Expected before / after

| Figure | Before | After |
|---|---|---|
| Credit Losses and Write-offs | 1,808,675,065 | 466,657,035 |
| A8 Agent Float Cycle Control | as reported | +1,342,015,030 movement, disclosed on its own line |
| Cash at Bank, Cash in Custody, Agent Float | unchanged | unchanged |
| Assets = Liabilities + Equity | holds | holds |
| Income Statement vs Balance Sheet gap | ≈ 1,523,977,000 | ≈ 182,393,000 (the X6 and recoveries items above) |

## Verification before it is called done

- Debits = credits on every affected group; no group left one-sided by the change.
- Assets − (Liabilities + Equity) = 0, before and after.
- Cash Flow closing cash still equals Balance Sheet cash exactly, and nothing returns to
  "unclassified".
- The write-off line reconciles, entry by entry, to `platform_loss_writeoff` alone.
- No balancing plug, suspense parking, or equity absorption introduced.

## Technical notes

Single change site: the `adj` CTE in `public.sofp_ledger_legs` — the branch keying on
`sc = 'wallet' AND acct0 = 'L1' AND n_wallet = 2 AND n_a2 = 1 AND n_l1 = 1`, which currently
returns `'X4'` with `dw = 'cash_in'`. It becomes `'A8'` with the debit/credit sense that keeps
the group balanced. Delivered as one migration replacing the function body, same signature,
plus a re-verification run of the three statements. `ledger_account_map` needs no new rows.
