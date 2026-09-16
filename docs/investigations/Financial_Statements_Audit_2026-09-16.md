# Read-only audit — Balance Sheet, Income Statement, Cash Flow (16 Sep 2026)

Read-only throughout. No ledger entry, migration, code path, mapping or figure was changed.
All figures recomputed independently from `general_ledger` via `sofp_ledger_legs(now())` and from
the operational tables, and compared with the statement functions themselves.

## 1. Independent trial balance (as at today, UGX)

| Code | Account | Net (Dr − Cr) |
|---|---|---|
| A1 | Cash and Bank Balances | 1,123,199,080 |
| A2 | Cash at Hand — Float with Agents | 123,999,178 |
| A3 | Rent Access Receivables (Tenants) | 883,746,266 |
| A4 | Advances and Other Receivables | 23,262,238 |
| A5 | Cash in Transit — not yet banked | 704,708,647 |
| A6 | Landlord Product Receivables | 32,035,000 |
| A7 | Partner Product Receivables | 777,450,008 |
| A8 | Agent and Merchant Float Cycle Control | (2,180,748,545) |
| L1 | Wallet Custody Payable | (351,790,755) |
| L2 | Partner Portfolios — Capital Held | (9,117,538,930) |
| L4/L6/L7 | Landlord payable / top-ups / treasury control | (90,418,230) |
| E1/E3/E4 | Capital, legacy opening, one-sided counterpart | (782,956,542) |
| R1 | Platform Revenue | (32,037,508) |
| X1–X6 | Expenses | 8,887,090,093 |

**Total debits = total credits exactly; Assets − (Liabilities + Equity) = 0.**
Arithmetically the Balance Sheet is sound. Supportability is where the defects are.

## 2. Balance Sheet — supportability defects

| Line | Ledger | Operational support | Difference |
|---|---|---|---|
| A3 Tenant receivables | 883,746,266 | 304,920,224 outstanding on funded/repaying plans | **overstated 578,826,042** |
| L2 Partner capital held | 9,117,538,930 | 8,345,755,409 active portfolios | **overstated 771,783,521** |
| L1 Wallet custody payable | 351,790,755 | 159,677,620 total wallet buckets | **overstated 192,113,135** |
| A2 Cash at hand with agents | 123,999,178 | 38,493,831 float in wallets | **overstated 85,505,347** |
| A4 Advances receivable | 23,262,238 | 45,215,547 agent advances outstanding | **understated 21,953,309** |
| A1 Cash at Bank | 1,123,199,080 | 1,310,670,843 verified banking declarations | **variance 187,471,763** |

Other findings:

- **A8 is a credit balance of 2,180,748,545 presented inside current assets.** It is in
  substance a control/liability position, not an asset; presenting it in assets understates
  total assets and misstates the asset section even though the totals still tie.
- **A7 Partner Product Receivables 777,450,008 has 851 debit legs and no credit legs at all** —
  nothing has ever been settled against it. This is the unpaid promissory-note promise
  population; it inflates assets and (via L2) liabilities by the same amount.
- **The balance check is true by construction.** 9,480 genuinely one-sided historic groups,
  571,085,015 of legs, are absorbed into equity account E4. The zero difference is therefore
  not evidence of correctness; it is the absorption working as designed and disclosed.
- **A1 variance basis:** of the 195 verified declarations totalling 1,310,670,843, only the 24
  float-backed ones (287,259,444) were posted to bank (the approved S2 decision). The 83
  custody-backed declarations (564,324,000) remain deliberately unposted and disclosed.

## 3. Income Statement

Mapping is internally consistent (each category in exactly one bucket, unmapped categories
flagged rather than absorbed). Independent recomputation of the mapped categories:

- Revenue 24,282,083 · contra-revenue 940,292 · Expenses 7,355,358,066 → **net loss ≈ 7,331,076,000**
- Balance-sheet retained earnings implies **net loss 8,855,052,585**

**The two statements disagree by ≈ 1,523,977,000.** Composition:

| Item | Amount | Effect |
|---|---|---|
| X4 "Credit Losses and Write-offs" that are not write-offs — float ⇄ withdrawable reclass (`bucket_reclass_in/out` 613,044,515, `wallet_transfer` 681,478,775, `wallet_deposit` 50,100,000, misc) | 1,341,583,790 | expensed on the Balance Sheet, **absent from the Income Statement** |
| X6 Float Restatement Adjustments (`system_balance_correction`) | 189,940,717 | expensed on the Balance Sheet, treated as non-P&L by the Income Statement |
| `listing_rejection_recovery` credited to R1 | 8,876,000 | revenue on the Balance Sheet, non-P&L on the Income Statement |

Only 466,657,035 of the 1,808,240,825 sitting in "Credit Losses and Write-offs" is a genuine
write-off (`platform_loss_writeoff`); **74% of that line is reclassification, not loss.**

Two platform categories are unmapped and therefore sit in the review queue rather than in any
line: `agent_float_cycle_settled_to_bank` and `verified_bank_cash_recognised`, 574,518,888 of
legs in total. Correctly excluded from profit or loss, but they should be explicitly classified
as non-P&L treasury routing so the review queue is empty.

## 4. Cash Flow

Verified against the function itself for 2026 year-to-date:

- Opening cash 0 + net movement 1,247,198,258 = closing cash 1,247,198,258 — **exact**.
- Closing cash = A1 1,123,199,080 + A2 123,999,178 = **Balance Sheet cash exactly**
  (`ties_to_balance_sheet: true`, `reconciles: true`).
- Cash in Transit (A5) and Float Cycle Control (A8) are excluded from cash and presented as
  classified counterpart movements — consistent with the Balance Sheet.
- Unclassified movements are zero. A single disclosed residual line of 1,323,215 carries
  genuine old single-sided postings. No plug, no artificial entry.

One presentation point: opening cash for 2026 is 0, which is correct on the ledger but only
because the 12 pre-2026 partner capital postings (68,475,381) were recorded as capital and a
custody reduction with **no cash leg at all**. Those historic transactions are missing their
cash side; the Cash Flow is right, the underlying postings are not.

## 5. Duplicates

81 transaction groups carry an identical category, direction and amount more than once,
excess value **15,681,000**. Small, and some are legitimate splits, but each needs eyeballing
to rule out a double post.

## 6. Summary of exceptions

| Type | Item | Amount |
|---|---|---|
| Overstatement | Tenant receivables | 578,826,042 |
| Overstatement | Partner capital held | 771,783,521 |
| Overstatement | Wallet custody payable | 192,113,135 |
| Overstatement | Cash at hand with agents | 85,505,347 |
| Overstatement | "Credit losses" that are reclassifications | 1,341,583,790 |
| Understatement | Advances receivable | 21,953,309 |
| Understatement | Income Statement loss vs Balance Sheet | 1,523,977,000 |
| Misclassification | A8 credit balance shown as a current asset | 2,180,748,545 |
| Reporting-only | A7 partner receivables never settled | 777,450,008 |
| Reporting-only | Equity absorption of one-sided historic legs (E4) | 571,085,015 |
| Unposted, disclosed | Custody-backed banking declarations | 564,324,000 |
| Variance | Cash at Bank vs verified declarations | 187,471,763 |
| Possible duplicates | 81 groups | 15,681,000 |

No corrections proposed here; any correction would be a separate, separately approved task.
