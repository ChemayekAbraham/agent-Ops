# Read-only audit — Statement of Cash Flows (16 Sep 2026)

Read-only. No code, SQL, migration, mapping, ledger entry or figure was changed. Statements were
read through the live reporting functions (`get_statement_of_cash_flows`,
`get_statement_of_financial_position`, `sofp_ledger_legs`) with a signed-in finance session;
integrity checks were run directly against `general_ledger`.

Period tested: 2026-01-01 → 2026-09-16. Balance Sheet as at 2026-09-16.

## 1. Headline reconciliation

| Measure | Amount (UGX) |
|---|---|
| Cash Flow closing cash | 1,238,684,758 |
| Balance Sheet cash (A1 1,123,199,080 + A2 115,485,678) | 1,238,684,758 |
| GL-derived closing cash (trial balance, same resolver) | 1,238,684,758 |
| **Difference, Cash Flow vs Balance Sheet** | **0** |
| **Difference, Cash Flow vs GL** | **0** |
| **Difference, Balance Sheet vs GL** | **0** |

Cash Flow internal proof: opening 0 + operating (1,370,935,512) + investing 0 + financing
2,609,620,270 = net 1,238,684,758 = closing. `reconciles: true`, `ties_to_balance_sheet: true`.

GL totals: **total debits 132,005,286,065 = total credits 132,005,286,065**, difference 0.
Balance sheet check: assets 2,826,843,597.24 = liabilities + equity 2,826,843,597.24, difference 0.

Opening cash of 0 for 2026 is correct on the ledger (A1/A2 carried no pre-2026 balance) but is a
presentation artefact of historic postings made without a cash leg, not of the report.

## 2. Cash vs non-cash treatment

- Cash is defined as A1 + A2 only. Cash in Transit (A5, 633,932,928) and Agent/Merchant Float
  Cycle Control (A8, −830,651,255) are excluded from cash and shown as counterpart movements —
  consistent with the Balance Sheet, which presents them as separate lines.
- Income Statement items reach the Cash Flow only through their cash counterpart: revenue
  to date 30,163,969 and expenses to date 7,537,346,459.63 are accrual figures, while the
  Cash Flow reflects only the legs that touched A1/A2. Non-cash items (receivable creation,
  wallet custody reclassification, float restatements) do not appear in cash.
- Unclassified movements: **zero**. One disclosed residual line of **1,323,215** carries genuine
  historic single-sided postings; it is labelled, not plugged.

## 3. Ledger integrity (production + legacy_real)

| Check | Result |
|---|---|
| Transaction groups examined | 265,062 |
| Groups with only one side | 13,178 — 1,583,589,800 |
| Groups that do not balance | 13,188 — 1,642,763,960 absolute |
| Same category/direction/amount posted more than once | 76 groups — excess 7,511,000 |

All of these are historic (pre-current-posting-rules) and are absorbed and disclosed via equity
account E4 (net −4,439,089 today), so the balance check remains true by construction rather than
by evidence. No new one-sided or unbalanced cash movement was found in the current period.

Classification treatment is correct and consistent:

| Classification | cash_in | cash_out | Statement treatment |
|---|---|---|---|
| production | 84,362,887,740.29 | 84,841,012,550.09 | included |
| legacy_real | 323,698,326 | 158,855,276 | included |
| admin_correction | 51,893,357,283.84 | 50,508,765,754.04 | excluded, disclosed |
| test_dev | 112,560,274 | 211,433,183 | excluded |

## 4. The 0114 tenant-collection posting

Verified for September 2026 on the `agent_collections` source. Every group carries both sides:

- tenant_repayment_collected (CR A3) 155,823,989 cash_out
  = cash_receipt_in_transit (DR A5) 149,759,953 + agent_float_used_for_rent 6,064,036 — exact.
- Commission legs pair exactly: agent_commission_earned 19,804,716 (wallet, DR)
  = agent_commission_payable 19,804,716 (platform, CR).
- All legs classified `production`; source table `agent_collections`.

Volumes are high (2,177 custody legs, 8,469 commission legs in the month) but the postings are
balanced, correctly classified, and correctly kept out of cash — the tenant collections sit in
Cash in Transit (A5), not in bank. Legitimacy of the volumes was not assessed, as instructed.

## 5. Differences and root causes

| Difference | Amount | Root cause |
|---|---|---|
| Cash Flow vs Balance Sheet cash | 0 | none |
| Cash Flow vs GL closing cash | 0 | none |
| GL debits vs credits | 0 | none |
| Disclosed residual inside Other Operating Activities | 1,323,215 | genuine historic single-sided postings, disclosed on its own line |
| Historic one-sided groups | 1,583,589,800 | pre-rules postings absorbed into equity E4; makes the balance tick self-fulfilling |
| Historic unbalanced groups | 1,642,763,960 | same population |
| Possible duplicate legs | 7,511,000 across 76 groups | identical category/direction/amount repeated in one group; some are legitimate splits, each needs eyeballing |
| 2026 opening cash shown as 0 | — | historic capital postings recorded with no cash leg |

## 6. Verdict

**PASS WITH DIFFERENCES.**

The Cash Flow itself reconciles exactly — to the General Ledger, to the Balance Sheet, and
internally, with no unclassified movements and no plug. The differences are all in the underlying
historic ledger population (one-sided and unbalanced legacy groups, 76 possible duplicates, missing
cash legs on pre-2026 capital), which the report discloses rather than conceals. Nothing was
changed and no correction is proposed here.
