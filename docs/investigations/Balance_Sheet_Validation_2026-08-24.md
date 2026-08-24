# CFO Balance Sheet — end-to-end validation report (24 Aug 2026, 06:00–06:20 UTC)

Validation only. **No ledger row was inserted, updated, deleted or reclassified**, no function,
mapping table or account catalog was modified. All work was read-only SQL plus one authenticated
read of the live CFO Balance Sheet screen.

## Method

1. The deployed reporting logic (`sofp_ledger_legs`, `get_statement_of_financial_position`) was read
   from the catalog and **re-implemented verbatim as a standalone read-only query**, so the totals
   could be reproduced independently of the function.
2. The live screen (`/cfo/dashboard` → Financial Reports → Balance Sheet, as at 24 Aug 2026) was
   rendered as a signed-in CFO and its figures compared with the independent recomputation.
3. Structural tests were run against `general_ledger` directly (group balance, mapping residuals,
   sign conventions, suspense accounts, duplicates, historical as-at dates).

Two figure sets appear below only because the ledger is live: the screen was captured at 06:10 UTC
and the independent recomputation at 06:18 UTC, 260,000 UGX of genuine new production postings
apart. Both balance to zero.

## Headline figures (as at 24 Aug 2026, end of day)

| Line | Live screen (06:10 UTC) | Independent recompute (06:18 UTC) |
|---|---|---|
| Total Assets | 378,308,903 | 378,048,903 |
| Total Liabilities | 7,674,638,196 | 7,674,379,496 |
| Total Equity (incl. retained earnings) | (7,296,329,293) | (7,296,330,593) |
| **Total Liabilities + Equity** | **378,308,903** | **378,048,903** |
| **Balance Sheet difference** | **0** | **0** |
| Total debits | 29,289,198,950 | 29,289,723,250 |
| Total credits | 29,289,198,950 | 29,289,723,250 |
| **Trial balance difference** | **0** | **0** |

## Test results

| # | Test | Result | Evidence |
|---|---|---|---|
| 1 | Total Assets = Total Liabilities + Equity | **PASS** | difference UGX 0 on screen and in recompute |
| 2 | Balance check state reported as balanced | **PASS** | screen: "Balanced — Total Assets = Total Liabilities + Equity (real ledger data, no plug)" |
| 3 | Total debits = total credits, same scope | **PASS** | 29,289,723,250 / 29,289,723,250, difference 0 |
| 4 | No suspense plug / hard-coded offset | **PASS** | `plug_applied=false`, `suspense_amount=0`; A9 suspense nets to **0** (dr 1,000,000 = cr 1,000,000, a real Aug-14 bridge reversal/reassignment pair). No literal amounts exist in the resolver. |
| 5 | Previously mis-mapped ledger-balanced groups now classified correctly | **PASS** | 1,401 groups are now touched by rules R1–R7 (was 1,114 in Aug; the same workflows keep posting). 1,400 of them are ledger-balanced and **all 1,400 now map to an equal debit and credit**. |
| 6 | No ledger-balanced group left mapped to one side | **PASS** | `raw_balanced_but_mapped_unbalanced = 0`, residual on raw-balanced groups = UGX 0 |
| 7 | `system_balance_correction` sign correct | **PASS** | platform legs resolve to A1 when the group touches agent float (dr 159,439,152 / cr 4,302,000) and to E3 otherwise (dr 248,920,157 / cr 376,681,964), the same `debit_when` convention as the sibling `platform.balance_correction` → E3 `cash_out`. Wallet counterparts sit on L1/A2. Every correction group balances. |
| 8 | One-sided legacy postings represented through itemised equity | **PASS** | 9,480 genuinely one-sided groups, UGX 571,085,015 gross (E4 dr 287,762,052 / cr 283,322,963), net equity line **(4,439,089)**, itemised by scope and category in the on-screen schedule |
| 9 | Reconciliation schedule contains no balanced groups | **PASS** | every scheduled group has a raw ledger imbalance; balanced groups are excluded by construction and test 6 confirms none remain |
| 10 | Revenue unchanged | **PASS** | R1 = 11,348,412; no leg moves into or out of R1 under rules R1–R7 |
| 11 | X1–X3 expenses unchanged | **PASS** | X1 1,719,255,612 / X2 2,891,773,817 / X3 1,050,140,935; the rule-change diff shows no leg entering or leaving X1, X2 or X3. Only X4 changes (1,264,019,475), which is the CFO-approved float-release cost recognition. |
| 12 | Cash Flow statement unaffected | **PASS** | `get_statement_of_cash_flows` does not reference `sofp_ledger_legs` (it reads `ledger_account_map` / `cash_flow_line_map`); `sofp_ledger_legs` is referenced by `get_statement_of_financial_position` only. Live screen: "Closing cash vs balance sheet cash … Difference UGX 0". |
| 13 | CFO dashboard cash figures unaffected | **PASS** | dashboard widgets read their own functions; no mapping table or ledger row was changed, so their inputs are identical |
| 14 | Historical periods balance | **PASS** | difference UGX 0 at 30 Jun 2026 (assets 2,242,278,911), 31 Mar 2026 (61,065,093), 31 Dec 2025 and 30 Jun 2025 (nil positions), i.e. legacy periods included |
| 15 | No duplicate transactions used to balance | **PASS** | 40 repeated leg signatures exist, all inside batch groups (e.g. `historical_balance_reseed` / `platform_loss_writeoff` multi-user batches) where each repetition carries its own matching counterpart; they are pre-existing, unrelated to the mapping fix, and net to zero |

## Category reconciliation against the ledger (independent recompute)

| Account | Label | Debits | Credits | Balance |
|---|---|---|---|---|
| A1 | Cash and bank | 6,058,574,152 | 5,719,595,058 | 338,979,094 |
| A2 | Cash at hand — float with agents | 2,969,705,894 | 2,630,148,441 | 339,557,453 |
| A3 | Rent access receivables | 835,064,135 | 31,499,793 | 803,564,342 |
| A4 | Advances and other receivables | 46,241,894 | 1,258,033,880 | (1,211,791,986) |
| A5 | Cash in transit | 129,080,000 | 21,340,000 | 107,740,000 |
| A9 | Suspense | 1,000,000 | 1,000,000 | **0** |
| L1 | Wallet custody payable | 8,936,282,201 | 9,455,466,241 | 519,184,040 |
| L2 | Partner portfolios — capital held | 152,572,603 | 7,254,621,065 | 7,102,048,462 |
| L6 | Partner top-ups awaiting application | 2,058,951,629 | 2,112,098,623 | 53,146,994 |
| E1 | Shareholders' capital | 0 | 96,174,000 | 96,174,000 |
| E3 | Legacy opening balance adjustments | 851,131,041 | 376,906,964 | (474,224,077) |
| E4 | Legacy one-sided postings counterpart | 287,762,052 | 283,322,963 | (4,439,089) |
| R1 | Revenue | 1,777,088 | 13,125,500 | 11,348,412 |
| X1 / X2 / X3 / X4 | Expenses | — | — | 1,719,255,612 / 2,891,773,817 / 1,050,140,935 / 1,264,019,475 |

Wallet-cache memo comparison (not part of the totals): cache withdrawable+locked 360,224,963 vs
ledger L1 519,184,040; cache float 18,827,519 vs ledger A2 339,557,453. These are cache-vs-ledger
gaps that already existed and are disclosed as memo lines by design — the ledger is the reported truth.

## Remaining reconciliation exceptions

1. **9,480 genuinely one-sided historic groups** (UGX 571,085,015 gross, net 4,439,089) — disclosed in
   equity account E4 and itemised on screen. Largest categories: `wallet_withdrawal` (1,164 groups,
   57,361,195), `agent_proxy_investment` (40, 38,140,720), `supporter_rent_fund` (25, 12,427,208),
   `agent_commission` bridge legs (2,326, 397,998).
2. **A4 carries a credit balance of (1,211,791,986)** — pre-existing and unchanged by the fix: most
   advance receivables were never posted to the ledger and live in operational sub-ledgers shown as
   memo lines. Closing it requires CFO-approved receivable legs; it is a money-recognition decision,
   not a mapping defect.
3. **Wallet cache vs ledger gaps** (item above) are monitored by the existing drift detectors.

## Conclusion

The Balance Sheet is genuinely balanced on real ledger data: assets equal liabilities plus equity to
the shilling, debits equal credits, the suspense account is empty, no plug or hard-coded offset
exists, every ledger-balanced group articulates across two sides, the `system_balance_correction`
sign is correct in both of its workflow variants, and revenue plus X1–X3 expenses, cash-flow figures
and dashboard cash are unchanged. All 15 tests PASS.
