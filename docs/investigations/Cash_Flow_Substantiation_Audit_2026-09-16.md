# Read-only audit — is Cash Flow cash actually supported? (16 Sep 2026)

Read-only. No code, SQL, mapping, ledger entry or figure changed. All figures recomputed from
`sofp_ledger_legs(now())` and from the operational/evidence tables.

Question tested: not "does it reconcile" (it does — proven previously) but "is each cash figure
backed by independent, identifiable evidence".

## 1. The reconciling figures

| Measure | UGX |
|---|---|
| A1 Cash and Bank Balances | 1,097,810,957 |
| A2 Cash at Hand — Float with Agents | 145,199,949 |
| **Cash Flow / Balance Sheet closing cash (A1+A2)** | **1,243,010,906** |
| A5 Cash in Transit (not cash equivalent) | 715,576,295 |
| A8 Float Cycle Control (not cash equivalent) | (860,365,526) |

These tie exactly. Substantiation is where they fail.

## 2. A1 — Cash and Bank: 1,097,810,957. NOT independently supported.

A1 is derived almost entirely from wallet postings, not from bank evidence:

| Category | Net (UGX) | Legs |
|---|---|---|
| wallet_withdrawal | (3,149,461,716) | 8,122 |
| partner_capital_cash_received | 2,552,949,162 | **1** |
| wallet_deposit | 1,796,357,185 | 694 |
| rent_disbursement | (739,732,727) | 1,360 |
| verified_bank_cash_recognised | 287,259,444 | 24 |
| wallet_transfer | 193,939,809 | 614 |
| treasury_bank_deposit | 172,420,000 | 40 |
| agent_landlord_payout | (17,461,000) | 84 |
| wallet_deduction | 1,540,800 | 3 |

- The single largest debit — **2,552,949,162** — is **one aggregate posting dated 12 Apr 2026**
  (group `44f42380…`, balanced against L2 partner capital). It is a lump reseed, not identifiable
  bank receipts. Nothing behind it can be traced to a dated bank credit.
- Only **287,259,444** of A1 comes from verified banking declarations (the 24 float-backed ones
  posted under the approved S2 decision).
- Independently verified declarations total **1,311,670,843** across 196 records:
  already_debited_to_bank 349,667,399 (54) · custody_backed 564,324,000 (83, deliberately
  unposted) · already_banked 110,420,000 (35) · float_backed 287,259,444 (24).
- **Variance A1 vs verified declarations: 213,859,886.** There is no bank-statement
  reconciliation anywhere in the system — no table holds an external bank balance or statement
  line to agree A1 to.

**Verdict: reconciles internally, unsupported externally.** A1 is a wallet-flow residual with a
2.55bn unidentified seed inside it.

## 3. A2 — Cash at Hand with Agents: 145,199,949. Overstated by 106,818,347.

Actual float held by agents, per the wallet buckets (96,664 wallets): **38,381,602**.
Ledger A2 is 3.8× that. The difference is unsupported by any agent-held cash record.

## 4. A5 — Cash in Custody: 715,576,295. Physically unverified.

- All of it arose in the last two months (Aug 305,480,000 · Sep 410,096,295); nothing older
  than 30 days, so it is not a stale-carry problem.
- Only **172,420,000** has ever been banked (`cash_in_transit_banked`) against 887,996,295
  collected (`cash_receipt_in_transit`) — **19%**.
- There is **no physical cash count, custody sign-off or bank credit** evidencing the remaining
  **543,156,295**. Correctly excluded from cash equivalents, but presented as an asset on no
  external proof.

## 5. A8 — Float Cycle Control: (860,365,526) presented inside current assets.

A credit balance in the asset section. In substance a control/liability position. Correctly kept
out of cash, but it misstates the asset section's composition.

## 6. Answer

The Cash Flow shows values that **reconcile** — to the General Ledger, to the Balance Sheet and
internally — but it does **not** show independently supported cash.

| Figure | Reconciles | Independently supported |
|---|---|---|
| A1 1,097,810,957 | yes | no — 2.55bn single seed; 213,859,886 variance to declarations; no bank statement agreement |
| A2 145,199,949 | yes | no — 106,818,347 above actual agent float |
| A5 715,576,295 | yes | no — 543,156,295 with no count, sign-off or banking |
| A8 (860,365,526) | yes | presentation defect (credit in assets) |

**Verdict: PASS ON RECONCILIATION, FAIL ON SUBSTANTIATION.**

Unsupported or unevidenced amounts touching the cash presentation total roughly
**863,834,528** (213,859,886 + 106,818,347 + 543,156,295), before the 2.55bn seed which
reconciles but cannot be traced to identifiable bank receipts.

Nothing was changed and no correction is proposed here.
