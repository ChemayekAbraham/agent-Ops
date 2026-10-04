# Merchant Float Full Trace — pre-14-Aug baseline through 16-Aug-2026 EAT (READ ONLY)

Scope: 12 merchant desks, all `general_ledger` legs with `ledger_scope='wallet'`, `wallet_bucket='float'`.
Anchor: first 14-Aug top-up event per desk; window closes 2026-08-16 23:59:59+03.
No data was modified in producing this report.

## Level 1 — Summary with variance

```
Desk                      Evid top-up   Asserted  Reversals   Payouts  Telecom   OtherOut   OtherIn RawNet(post)    BaseNet
Hilary Evanz                7,000,000  1,860,999-14,000,000    15,600    1,000          0         0   -5,155,601      3,500
Bayo Mercy                  5,660,000 13,415,000-11,320,000         0        0          0         0    7,755,000-31,780,000
NABBALE CLAIRE              5,000,000  6,238,797-10,000,000    91,500    2,000  5,000,000         0   -3,854,703          0
Tugabirwe Apophia           5,000,000  1,111,329-10,000,000   456,772    7,600          0         0   -4,353,043          0
JOSHUA WANDA                4,647,000  1,710,000 -6,300,000    60,000    1,000  3,441,610         0   -3,445,610   -243,300
Nankambo sharimah           3,000,000  1,000,000 -6,000,000         0        0  2,505,000 5,290,000      785,000 -1,177,681
Babrah Tusingwire           2,000,000  2,000,000 -4,000,000    43,614      500          0         0      -44,114          0
Catherine Nabaggala         2,000,000  2,000,000 -4,000,000    12,900      500          0         0      -13,400 -3,711,845
Mudumba samuel                      0  2,395,669          0   183,836    3,200          0         0    2,208,633          0
MULUNGI AIDAH                       0    566,133          0    28,000      500          0         0      537,633 -4,069,300
Nakajjubi Shamirah                  0  1,968,748          0         0        0          0         0    1,968,748          0
NAMULINDWA IMMECULATE               0    390,750          0   289,550    3,500          0         0       97,700 -9,379,346
TOTAL                      34,307,000 34,657,425-65,620,000 1,181,772   19,800 10,946,610 5,290,000   -3,513,757
```

### Key findings

1. **Every 14-Aug evidenced top-up was reversed TWICE.** Each sweep produced an
   `agent_float_deposit / admin_correction` reversal AND a `system_balance_correction`
   reversal of the identical amount and reference, both at 17:03–17:06 on 14-Aug:

```
Desk                      ledger rev  balance rev phantom debit
Hilary Evanz               7,000,000    7,000,000     7,000,000
Bayo Mercy                 5,660,000    5,660,000     5,660,000
NABBALE CLAIRE             5,000,000    5,000,000     5,000,000
Tugabirwe Apophia          5,000,000    5,000,000     5,000,000
JOSHUA WANDA               3,150,000    3,150,000     3,150,000
Nankambo sharimah          3,000,000    3,000,000     3,000,000
Babrah Tusingwire          2,000,000    2,000,000     2,000,000
Catherine Nabaggala        2,000,000    2,000,000     2,000,000
TOTAL PHANTOM DEBIT                                  32,810,000
```

   Net effect: **UGX 32,810,000 of evidenced provider cash was debited twice**, so raw
   ledger nets go deeply negative and the wallet cache floors at zero (clamp artifact).

2. **UGX 34,657,425 of "top-ups" carry no provider evidence.** They originate from
   `merchant_float_reconciliations` (`merchant_opening_float:*` idempotency keys) — book
   assertions, not money movement. Largest: Bayo Mercy 13,415,000; NABBALE CLAIRE
   6,238,797; Mudumba samuel 2,395,669; Nakajjubi Shamirah 1,968,748.

3. **Only UGX 34,307,000 of the trace window's inflows are provider-evidenced** (MTN/Airtel
   TIDs matched in `gmail_transactions`) — and all of that was reversed twice as above.

4. **Customer payouts in the window are small**: UGX 1,181,772 principal plus UGX 19,800
   telecom sending charges (tiered 100/500/1,000 per `src/lib/cashoutCharges.ts`). Telecom
   charges are correctly posted as a paired second float debit on every settlement — no
   missing charge legs found.

5. **Non-settlement float outflows: UGX 10,946,610** — operator moves
   (`finops_wallet_move`, `agent_float_assignment`) and error corrections, not cash-outs.
   These are the desk-to-desk reshuffles between NABBALE CLAIRE, Nankambo sharimah,
   JOSHUA WANDA and platform.

## Bayo Mercy — Equity account UGX 13,776,000

Traced separately and **NOT FOUND**. The figure 13,776,000 (and 13,776) does not exist in:
`general_ledger` (any scope/bucket/date), `gmail_transactions` (any channel), or
`deposit_requests`. There is no Equity-bank leg attributable to her desk.

What her all-time float history does show:
- Provider-evidenced MTN inflows attributable to MERCY BAYO in `gmail_transactions`:
  27,800,000 total across 9 receipts (22-May → 12-Aug).
- Large float debits: 20,915,000 (21-Jul, CFO "Wallet Retraction — Not hers"),
  20,000,000 (10-Aug, operator move to AWOR HELLEN), 5,000,000 (03-Aug error correction),
  5,000,000 (08-Jun reclass to withdrawable), plus four duplicate 755,000 CFO debits on 03-Jun.
- Her 13,415,000 of 14-Aug "opening balance" credits are self-referenced
  `merchant_float_reconciliations` rows — the same class of assertion flagged in the
  16-Aug audit, with no Equity or MoMo counterpart.

Conclusion: the 13,776,000 "Equity account" figure is **UNTRACED** — it has no ledger,
email, or deposit footprint. It cannot be substantiated from platform data.

## Level 2 — Itemized trace (per desk, EAT)


### Babrah Tusingwire
Raw ledger float net before first 14-Aug event: **UGX 0**

| Time (EAT) | Category | Class | Dir | Amount | Running balance after this leg | Provider evidence | Note |
|---|---|---|---|---|---|---|---|
| 2026-08-14 16:55:02 | agent_float_deposit | production | cash_in | 2,000,000 | 2,000,000 | YES (TID) | Operational float deposit via airtel |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 2,000,000 | 0 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 2,000,000 | -2,000,000 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |
| 2026-08-14 20:02:26 | agent_float_deposit | production | cash_in | 2,000,000 | 0 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: Balance corrections |
| 2026-08-15 16:42:40 | agent_float_settlement | production | cash_out | 43,614 | -43,614 | none | Company float used to settle customer cash-out 9d5baeab-6952-4152-b874 |
| 2026-08-15 16:42:40 | agent_float_settlement | production | cash_out | 500 | -44,114 | none | Telecom sending charge for merchant cash-out 9d5baeab-6952-4152-b874-8 |

Raw ledger net after trace: **UGX -44,114** vs wallet cache **UGX 1,955,886** → clamp/variance **UGX 2,000,000**
Final running balance from the column above: **UGX -44,114** — matches the stated raw ledger net after trace.

### Bayo Mercy
Raw ledger float net before first 14-Aug event: **UGX -31,780,000**

| Time (EAT) | Category | Class | Dir | Amount | Running balance after this leg | Provider evidence | Note |
|---|---|---|---|---|---|---|---|
| 2026-08-14 10:36:06 | agent_float_deposit | production | cash_in | 5,000,000 | -26,780,000 | none | Operational float deposit via mtn |
| 2026-08-14 13:16:06 | agent_float_deposit | production | cash_in | 3,415,000 | -23,365,000 | none | Operational float deposit via mtn |
| 2026-08-14 13:48:09 | agent_float_deposit | production | cash_in | 5,000,000 | -18,365,000 | none | Operational float deposit via mtn |
| 2026-08-14 16:55:32 | agent_float_deposit | production | cash_in | 5,000,000 | -13,365,000 | YES (TID) | Operational float deposit via mtn |
| 2026-08-14 16:55:38 | agent_float_deposit | production | cash_in | 500,000 | -12,865,000 | YES (TID) | Operational float deposit via mtn |
| 2026-08-14 16:56:14 | agent_float_deposit | production | cash_in | 50,000 | -12,815,000 | YES (TID) | Operational float deposit via mtn |
| 2026-08-14 16:56:19 | agent_float_deposit | production | cash_in | 110,000 | -12,705,000 | YES (TID) | Operational float deposit via mtn |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 50,000 | -12,755,000 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 110,000 | -12,865,000 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 500,000 | -13,365,000 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 5,000,000 | -18,365,000 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 50,000 | -18,415,000 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 5,000,000 | -23,415,000 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 110,000 | -23,525,000 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 500,000 | -24,025,000 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |

Raw ledger net after trace: **UGX -24,025,000** vs wallet cache **UGX 18,415,000** → clamp/variance **UGX 42,440,000**
Final running balance from the column above: **UGX -24,025,000** — matches the stated raw ledger net after trace.

### Catherine Nabaggala
Raw ledger float net before first 14-Aug event: **UGX -3,711,845**

| Time (EAT) | Category | Class | Dir | Amount | Running balance after this leg | Provider evidence | Note |
|---|---|---|---|---|---|---|---|
| 2026-08-14 16:55:15 | agent_float_deposit | production | cash_in | 2,000,000 | -1,711,845 | YES (TID) | Operational float deposit via airtel |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 2,000,000 | -3,711,845 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 2,000,000 | -5,711,845 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |
| 2026-08-14 18:22:22 | agent_float_deposit | production | cash_in | 201,492 | -5,510,353 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: balance correction |
| 2026-08-14 19:55:02 | agent_float_deposit | production | cash_in | 1,798,508 | -3,711,845 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: Balance correction |
| 2026-08-15 18:10:29 | agent_float_settlement | production | cash_out | 12,900 | -3,724,745 | none | Company float used to settle customer cash-out 6db59411-3461-4aa1-90a3 |
| 2026-08-15 18:10:29 | agent_float_settlement | production | cash_out | 500 | -3,725,245 | none | Telecom sending charge for merchant cash-out 6db59411-3461-4aa1-90a3-a |

Raw ledger net after trace: **UGX -3,725,245** vs wallet cache **UGX 1,988,092** → clamp/variance **UGX 5,713,337**
Final running balance from the column above: **UGX -3,725,245** — matches the stated raw ledger net after trace.

### Hilary Evanz
Raw ledger float net before first 14-Aug event: **UGX 3,500**

| Time (EAT) | Category | Class | Dir | Amount | Running balance after this leg | Provider evidence | Note |
|---|---|---|---|---|---|---|---|
| 2026-08-14 16:55:20 | agent_float_deposit | production | cash_in | 2,000,000 | 2,003,500 | YES (TID) | Operational float deposit via airtel |
| 2026-08-14 16:56:10 | agent_float_deposit | production | cash_in | 5,000,000 | 7,003,500 | YES (TID) | Operational float deposit via airtel |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 2,000,000 | 5,003,500 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 5,000,000 | 3,500 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 2,000,000 | -1,996,500 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 5,000,000 | -6,996,500 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |
| 2026-08-14 17:53:13 | agent_float_settlement | production | cash_out | 3,500 | -7,000,000 | none | Company float used to settle customer cash-out 9865962c-2b79-480f-8f05 |
| 2026-08-14 19:56:34 | agent_float_deposit | production | cash_in | 1,860,999 | -5,139,001 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: Balance Correction |
| 2026-08-16 10:59:41 | agent_float_settlement | production | cash_out | 6,100 | -5,145,101 | none | Company float used to settle customer cash-out 6b449f28-9553-46a0-9a12 |
| 2026-08-16 10:59:41 | agent_float_settlement | production | cash_out | 500 | -5,145,601 | none | Telecom sending charge for merchant cash-out 6b449f28-9553-46a0-9a12-6 |
| 2026-08-16 15:44:38 | agent_float_settlement | production | cash_out | 6,000 | -5,151,601 | none | Company float used to settle customer cash-out e313a5f4-88f4-4e05-929e |
| 2026-08-16 15:44:39 | agent_float_settlement | production | cash_out | 500 | -5,152,101 | none | Telecom sending charge for merchant cash-out e313a5f4-88f4-4e05-929e-8 |

Raw ledger net after trace: **UGX -5,152,101** vs wallet cache **UGX 1,847,899** → clamp/variance **UGX 7,000,000**
Final running balance from the column above: **UGX -5,152,101** — matches the stated raw ledger net after trace.

### JOSHUA WANDA
Raw ledger float net before first 14-Aug event: **UGX -243,300**

| Time (EAT) | Category | Class | Dir | Amount | Running balance after this leg | Provider evidence | Note |
|---|---|---|---|---|---|---|---|
| 2026-08-14 10:18:07 | agent_float_deposit | production | cash_in | 950,000 | 706,700 | none | Operational float deposit via airtel |
| 2026-08-14 13:18:44 | agent_float_assignment | production | cash_out | 1,000,000 | -293,300 | none | Operator move: sent UGX 1,000,000 from Float to Nankambo sharimah (Flo |
| 2026-08-14 14:15:23 | agent_float_settlement | production | cash_out | 50,000 | -343,300 | none | Company float used to settle customer cash-out 775219b0-aeee-4420-8f94 |
| 2026-08-14 14:15:23 | agent_float_settlement | production | cash_out | 500 | -343,800 | none | Telecom sending charge for merchant cash-out 775219b0-aeee-4420-8f94-d |
| 2026-08-14 16:00:19 | agent_float_deposit | production | cash_in | 100,000 | -243,800 | YES (TID) | Operational float deposit via airtel |
| 2026-08-14 16:44:15 | agent_float_deposit | production | cash_in | 50,000 | -193,800 | YES (TID) | Operational float deposit via airtel |
| 2026-08-14 16:54:03 | agent_float_deposit | production | cash_in | 60,000 | -133,800 | YES (TID) | Operational float deposit via airtel |
| 2026-08-14 16:55:24 | agent_float_deposit | production | cash_in | 950,000 | 816,200 | YES (TID) | Operational float deposit via airtel |
| 2026-08-14 16:55:43 | agent_float_deposit | production | cash_in | 1,200,000 | 2,016,200 | YES (TID) | Operational float deposit via airtel |
| 2026-08-14 16:55:47 | agent_float_deposit | production | cash_in | 1,000,000 | 3,016,200 | YES (TID) | Operational float deposit via airtel |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 1,200,000 | 1,816,200 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 1,000,000 | 816,200 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 950,000 | -133,800 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 950,000 | -1,083,800 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 1,000,000 | -2,083,800 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 1,200,000 | -3,283,800 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |
| 2026-08-14 17:20:04 | agent_float_deposit | production | cash_in | 50,000 | -3,233,800 | YES (TID) | Operational float deposit via airtel |
| 2026-08-14 17:25:13 | agent_float_settlement | production | cash_out | 10,000 | -3,243,800 | none | Company float used to settle customer cash-out 4356a27a-e295-4a8f-996f |
| 2026-08-14 17:25:13 | agent_float_settlement | production | cash_out | 500 | -3,244,300 | none | Telecom sending charge for merchant cash-out 4356a27a-e295-4a8f-996f-6 |
| 2026-08-14 18:53:51 | agent_float_deposit | production | cash_in | 37,000 | -3,207,300 | YES (TID) | Company float delivery to merchant agent via airtel (TID 153965311171) |
| 2026-08-14 19:23:40 | agent_float_deposit | production | cash_in | 650,000 | -2,557,300 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: Another demo |
| 2026-08-14 19:38:57 | agent_float_deposit | production | cash_in | 1,200,000 | -1,357,300 | YES (TID) | Company float delivery to merchant agent via airtel (TID 153970188672) |
| 2026-08-14 21:16:02 | agent_float_deposit | production | cash_in | 100,000 | -1,257,300 | none | Operational float deposit via airtel |
| 2026-08-15 06:39:21 | agent_float_assignment | production | cash_out | 2,441,610 | -3,698,910 | none | Error correction: returned UGX 2,441,610 from JOSHUA WANDA's Float to  |
| 2026-08-15 13:16:02 | agent_float_deposit | production | cash_in | 10,000 | -3,688,910 | none | Operational float deposit via airtel |

Raw ledger net after trace: **UGX -3,688,910** vs wallet cache **UGX 43,800** → clamp/variance **UGX 3,732,710**
Final running balance from the column above: **UGX -3,688,910** — matches the stated raw ledger net after trace.

### MULUNGI AIDAH
Raw ledger float net before first 14-Aug event: **UGX -4,069,300**

| Time (EAT) | Category | Class | Dir | Amount | Running balance after this leg | Provider evidence | Note |
|---|---|---|---|---|---|---|---|
| 2026-08-14 20:09:38 | agent_float_deposit | production | cash_in | 566,133 | -3,503,167 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: Balance correction |
| 2026-08-15 18:14:50 | agent_float_settlement | production | cash_out | 28,000 | -3,531,167 | none | Company float used to settle customer cash-out ccc12577-6d5c-4179-bbc4 |
| 2026-08-15 18:14:50 | agent_float_settlement | production | cash_out | 500 | -3,531,667 | none | Telecom sending charge for merchant cash-out ccc12577-6d5c-4179-bbc4-d |

Raw ledger net after trace: **UGX -3,531,667** vs wallet cache **UGX 537,633** → clamp/variance **UGX 4,069,300**
Final running balance from the column above: **UGX -3,531,667** — matches the stated raw ledger net after trace.

### Mudumba samuel
Raw ledger float net before first 14-Aug event: **UGX 0**

| Time (EAT) | Category | Class | Dir | Amount | Running balance after this leg | Provider evidence | Note |
|---|---|---|---|---|---|---|---|
| 2026-08-14 20:12:29 | agent_float_deposit | production | cash_in | 2,395,669 | 2,395,669 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: Balance correction |
| 2026-08-15 09:44:43 | agent_float_settlement | production | cash_out | 6,000 | 2,389,669 | none | Company float used to settle customer cash-out aff95381-0483-4bd2-8904 |
| 2026-08-15 09:44:43 | agent_float_settlement | production | cash_out | 500 | 2,389,169 | none | Telecom sending charge for merchant cash-out aff95381-0483-4bd2-8904-1 |
| 2026-08-15 11:55:06 | agent_float_settlement | production | cash_out | 10,356 | 2,378,813 | none | Company float used to settle customer cash-out 5643d6a2-2b85-42ff-a3c4 |
| 2026-08-15 11:55:06 | agent_float_settlement | production | cash_out | 500 | 2,378,313 | none | Telecom sending charge for merchant cash-out 5643d6a2-2b85-42ff-a3c4-7 |
| 2026-08-15 17:33:32 | agent_float_settlement | production | cash_out | 30,000 | 2,348,313 | none | Company float used to settle customer cash-out 190102c7-603d-4932-b356 |
| 2026-08-15 17:33:32 | agent_float_settlement | production | cash_out | 500 | 2,347,813 | none | Telecom sending charge for merchant cash-out 190102c7-603d-4932-b356-7 |
| 2026-08-15 21:09:57 | agent_float_settlement | production | cash_out | 6,480 | 2,341,333 | none | Company float used to settle customer cash-out 20bfcdcb-cb7f-4600-905f |
| 2026-08-15 21:09:57 | agent_float_settlement | production | cash_out | 500 | 2,340,833 | none | Telecom sending charge for merchant cash-out 20bfcdcb-cb7f-4600-905f-7 |
| 2026-08-15 23:30:56 | agent_float_settlement | production | cash_out | 121,000 | 2,219,833 | none | Company float used to settle customer cash-out f462c780-6e3b-47bf-9899 |
| 2026-08-15 23:30:56 | agent_float_settlement | production | cash_out | 1,000 | 2,218,833 | none | Telecom sending charge for merchant cash-out f462c780-6e3b-47bf-9899-a |
| 2026-08-16 12:24:49 | agent_float_settlement | production | cash_out | 5,000 | 2,213,833 | none | Company float used to settle customer cash-out 1f61cd4a-a914-4083-9743 |
| 2026-08-16 12:24:49 | agent_float_settlement | production | cash_out | 100 | 2,213,733 | none | Telecom sending charge for merchant cash-out 1f61cd4a-a914-4083-9743-4 |
| 2026-08-16 15:12:36 | agent_float_settlement | production | cash_out | 5,000 | 2,208,733 | none | Company float used to settle customer cash-out f270601c-2b3c-437f-b05c |
| 2026-08-16 15:12:36 | agent_float_settlement | production | cash_out | 100 | 2,208,633 | none | Telecom sending charge for merchant cash-out f270601c-2b3c-437f-b05c-b |

Raw ledger net after trace: **UGX 2,208,633** vs wallet cache **UGX 2,208,633** → clamp/variance **UGX 0**
Final running balance from the column above: **UGX 2,208,633** — matches the stated raw ledger net after trace.

### NABBALE CLAIRE
Raw ledger float net before first 14-Aug event: **UGX 0**

| Time (EAT) | Category | Class | Dir | Amount | Running balance after this leg | Provider evidence | Note |
|---|---|---|---|---|---|---|---|
| 2026-08-14 13:48:11 | agent_float_deposit | production | cash_in | 5,000,000 | 5,000,000 | none | Operational float deposit via mtn |
| 2026-08-14 13:50:41 | agent_float_assignment | production | cash_out | 600,000 | 4,400,000 | none | Operator move: sent UGX 600,000 from Float to sir ian martin (Withdraw |
| 2026-08-14 13:52:21 | agent_float_assignment | production | cash_out | 3,000,000 | 1,400,000 | none | Operator move: sent UGX 3,000,000 from Float to Nankambo sharimah (Flo |
| 2026-08-14 13:53:20 | agent_float_assignment | production | cash_out | 1,400,000 | 0 | none | Error correction: returned UGX 1,400,000 from NABBALE CLAIRE's Float t |
| 2026-08-14 16:55:29 | agent_float_deposit | production | cash_in | 3,000,000 | 3,000,000 | YES (TID) | Operational float deposit via mtn |
| 2026-08-14 16:56:05 | agent_float_deposit | production | cash_in | 2,000,000 | 5,000,000 | YES (TID) | Operational float deposit via mtn |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 2,000,000 | 3,000,000 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 3,000,000 | 0 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:04:56 | agent_float_settlement | production | cash_out | 78,000 | -78,000 | none | Company float used to settle customer cash-out 98d2c03d-ff52-49fc-8349 |
| 2026-08-14 17:04:56 | agent_float_settlement | production | cash_out | 1,000 | -79,000 | none | Telecom sending charge for merchant cash-out 98d2c03d-ff52-49fc-8349-c |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 3,000,000 | -3,079,000 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 2,000,000 | -5,079,000 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |
| 2026-08-14 19:59:47 | agent_float_deposit | production | cash_in | 959,797 | -4,119,203 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: Balance correction |
| 2026-08-14 20:19:06 | agent_float_deposit | production | cash_in | 79,000 | -4,040,203 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: Balance correction |
| 2026-08-16 18:34:04 | agent_float_deposit | production | cash_in | 100,000 | -3,940,203 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: bal correction |
| 2026-08-16 18:37:24 | agent_float_deposit | production | cash_in | 100,000 | -3,840,203 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: bal correction |
| 2026-08-16 19:12:06 | agent_float_settlement | production | cash_out | 7,500 | -3,847,703 | none | Company float used to settle customer cash-out 733f29f6-4325-4143-a942 |
| 2026-08-16 19:12:06 | agent_float_settlement | production | cash_out | 500 | -3,848,203 | none | Telecom sending charge for merchant cash-out 733f29f6-4325-4143-a942-5 |
| 2026-08-16 20:06:39 | agent_float_settlement | production | cash_out | 6,000 | -3,854,203 | none | Company float used to settle customer cash-out 342654c1-42f4-442f-9a8d |
| 2026-08-16 20:06:39 | agent_float_settlement | production | cash_out | 500 | -3,854,703 | none | Telecom sending charge for merchant cash-out 342654c1-42f4-442f-9a8d-6 |

Raw ledger net after trace: **UGX -3,854,703** vs wallet cache **UGX 1,145,297** → clamp/variance **UGX 5,000,000**
Final running balance from the column above: **UGX -3,854,703** — matches the stated raw ledger net after trace.

### NAMULINDWA IMMECULATE
Raw ledger float net before first 14-Aug event: **UGX -9,379,346**

| Time (EAT) | Category | Class | Dir | Amount | Running balance after this leg | Provider evidence | Note |
|---|---|---|---|---|---|---|---|
| 2026-08-14 20:04:34 | agent_float_deposit | production | cash_in | 390,750 | -8,988,596 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: Balance correction |
| 2026-08-15 12:01:46 | agent_float_settlement | production | cash_out | 235,000 | -9,223,596 | none | Company float used to settle customer cash-out d9d9ccfb-42e9-4640-8158 |
| 2026-08-15 12:01:46 | agent_float_settlement | production | cash_out | 1,000 | -9,224,596 | none | Telecom sending charge for merchant cash-out d9d9ccfb-42e9-4640-8158-7 |
| 2026-08-15 12:14:34 | agent_float_settlement | production | cash_out | 10,000 | -9,234,596 | none | Company float used to settle customer cash-out 5201cf9b-e0cd-4e7f-a0df |
| 2026-08-15 12:14:34 | agent_float_settlement | production | cash_out | 500 | -9,235,096 | none | Telecom sending charge for merchant cash-out 5201cf9b-e0cd-4e7f-a0df-7 |
| 2026-08-15 21:49:50 | agent_float_settlement | production | cash_out | 10,000 | -9,245,096 | none | Company float used to settle customer cash-out 8035d4b4-1c8f-44b2-ab37 |
| 2026-08-15 21:49:50 | agent_float_settlement | production | cash_out | 500 | -9,245,596 | none | Telecom sending charge for merchant cash-out 8035d4b4-1c8f-44b2-ab37-4 |
| 2026-08-15 21:54:12 | agent_float_settlement | production | cash_out | 5,300 | -9,250,896 | none | Company float used to settle customer cash-out 416cd53b-90cb-4d3f-b739 |
| 2026-08-15 21:54:12 | agent_float_settlement | production | cash_out | 500 | -9,251,396 | none | Telecom sending charge for merchant cash-out 416cd53b-90cb-4d3f-b739-3 |
| 2026-08-16 07:14:02 | agent_float_settlement | production | cash_out | 8,000 | -9,259,396 | none | Company float used to settle customer cash-out 938bb2a5-f03e-475e-b39d |
| 2026-08-16 07:14:02 | agent_float_settlement | production | cash_out | 500 | -9,259,896 | none | Telecom sending charge for merchant cash-out 938bb2a5-f03e-475e-b39d-7 |
| 2026-08-16 20:51:42 | agent_float_settlement | production | cash_out | 21,250 | -9,281,146 | none | Company float used to settle customer cash-out 66886808-b0ba-4f9b-ab32 |
| 2026-08-16 20:51:42 | agent_float_settlement | production | cash_out | 500 | -9,281,646 | none | Telecom sending charge for merchant cash-out 66886808-b0ba-4f9b-ab32-6 |

Raw ledger net after trace: **UGX -9,281,646** vs wallet cache **UGX 1,743,954** → clamp/variance **UGX 11,025,600**
Final running balance from the column above: **UGX -9,281,646** — matches the stated raw ledger net after trace.

### Nakajjubi Shamirah
Raw ledger float net before first 14-Aug event: **UGX 0**

| Time (EAT) | Category | Class | Dir | Amount | Running balance after this leg | Provider evidence | Note |
|---|---|---|---|---|---|---|---|
| 2026-08-14 20:17:04 | agent_float_deposit | production | cash_in | 1,968,748 | 1,968,748 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: Balance correction |

Raw ledger net after trace: **UGX 1,968,748** vs wallet cache **UGX 1,968,748** → clamp/variance **UGX 0**
Final running balance from the column above: **UGX 1,968,748** — matches the stated raw ledger net after trace.

### Nankambo sharimah
Raw ledger float net before first 14-Aug event: **UGX -1,177,681**

| Time (EAT) | Category | Class | Dir | Amount | Running balance after this leg | Provider evidence | Note |
|---|---|---|---|---|---|---|---|
| 2026-08-14 09:57:33 | agent_float_deposit | production | cash_in | 1,000,000 | -177,681 | none | Operational float deposit via cash_deposit |
| 2026-08-14 10:36:00 | agent_float_assignment | production | cash_in | 90,000 | -87,681 | none | Operator move: received UGX 90,000 into Float from CHEPTOEK SALOME ALI |
| 2026-08-14 13:18:44 | agent_float_assignment | production | cash_in | 1,000,000 | 912,319 | none | Operator move: received UGX 1,000,000 into Float from JOSHUA WANDA (Fl |
| 2026-08-14 13:26:06 | agent_float_assignment | production | cash_out | 300,000 | 612,319 | none | Operator move: sent UGX 300,000 from Float to ABER RACHEL (Withdrawabl |
| 2026-08-14 13:52:21 | agent_float_assignment | production | cash_in | 3,000,000 | 3,612,319 | none | Operator move: received UGX 3,000,000 into Float from NABBALE CLAIRE ( |
| 2026-08-14 14:50:27 | agent_float_assignment | production | cash_in | 1,200,000 | 4,812,319 | none | Operator move: received UGX 1,200,000 into Float from Grace Paul Ochie |
| 2026-08-14 15:34:08 | agent_float_assignment | production | cash_out | 1,200,000 | 3,612,319 | none | Operator move: sent UGX 1,200,000 from Float to Grace Paul Ochieng (Wi |
| 2026-08-14 16:38:57 | agent_float_assignment | production | cash_out | 5,000 | 3,607,319 | none | Operator move: sent UGX 5,000 from Float to KIPLANGATI CALEB (Withdraw |
| 2026-08-14 16:52:15 | agent_float_assignment | production | cash_out | 1,000,000 | 2,607,319 | none | Operator move: sent UGX 1,000,000 from Float to Amarachi Nabaasa (With |
| 2026-08-14 16:56:24 | agent_float_deposit | production | cash_in | 3,000,000 | 5,607,319 | YES (TID) | Operational float deposit via airtel |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 3,000,000 | 2,607,319 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 3,000,000 | -392,681 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |

Raw ledger net after trace: **UGX -392,681** vs wallet cache **UGX 4,810,319** → clamp/variance **UGX 5,203,000**
Final running balance from the column above: **UGX -392,681** — matches the stated raw ledger net after trace.

### Tugabirwe Apophia
Raw ledger float net before first 14-Aug event: **UGX 0**

| Time (EAT) | Category | Class | Dir | Amount | Running balance after this leg | Provider evidence | Note |
|---|---|---|---|---|---|---|---|
| 2026-08-14 16:55:10 | agent_float_deposit | production | cash_in | 5,000,000 | 5,000,000 | YES (TID) | Operational float deposit via mtn |
| 2026-08-14 17:03:55 | agent_float_deposit | admin_correction | cash_out | 5,000,000 | 0 | YES (TID) | Reversal: automatic historical merchant float sweep reversed (2026-08- |
| 2026-08-14 17:06:34 | system_balance_correction | admin_correction | cash_out | 5,000,000 | -5,000,000 | YES (TID) | SECOND debit of same sweep — Balance effect: historical merchant float sweep credit settled back (2026-08-14) |
| 2026-08-14 20:07:17 | agent_float_deposit | production | cash_in | 1,111,329 | -3,888,671 | none | ASSERTED opening balance — Merchant float opening balance recognised on the books: Balance correction |
| 2026-08-15 11:51:25 | agent_float_settlement | production | cash_out | 50,000 | -3,938,671 | none | Company float used to settle customer cash-out f7344b57-85a7-4636-873d |
| 2026-08-15 11:51:25 | agent_float_settlement | production | cash_out | 500 | -3,939,171 | none | Telecom sending charge for merchant cash-out f7344b57-85a7-4636-873d-c |
| 2026-08-15 12:53:11 | agent_float_settlement | production | cash_out | 100,000 | -4,039,171 | none | Company float used to settle customer cash-out 5cc14e3f-549f-4109-896f |
| 2026-08-15 12:53:11 | agent_float_settlement | production | cash_out | 1,000 | -4,040,171 | none | Telecom sending charge for merchant cash-out 5cc14e3f-549f-4109-896f-1 |
| 2026-08-15 13:03:12 | agent_float_settlement | production | cash_out | 100,000 | -4,140,171 | none | Company float used to settle customer cash-out 93c2b85e-4853-4520-b709 |
| 2026-08-15 13:03:12 | agent_float_settlement | production | cash_out | 1,000 | -4,141,171 | none | Telecom sending charge for merchant cash-out 93c2b85e-4853-4520-b709-4 |
| 2026-08-15 15:12:18 | agent_float_settlement | production | cash_out | 44,500 | -4,185,671 | none | Company float used to settle customer cash-out dc441760-2dd3-4bb8-bb14 |
| 2026-08-15 15:12:18 | agent_float_settlement | production | cash_out | 500 | -4,186,171 | none | Telecom sending charge for merchant cash-out dc441760-2dd3-4bb8-bb14-4 |
| 2026-08-16 09:25:14 | agent_float_settlement | production | cash_out | 7,000 | -4,193,171 | none | Company float used to settle customer cash-out 2a7ebfa9-09c0-4e45-bc55 |
| 2026-08-16 09:25:14 | agent_float_settlement | production | cash_out | 500 | -4,193,671 | none | Telecom sending charge for merchant cash-out 2a7ebfa9-09c0-4e45-bc55-a |
| 2026-08-16 09:29:45 | agent_float_settlement | production | cash_out | 5,000 | -4,198,671 | none | Company float used to settle customer cash-out c2d1a5fe-7b4f-4e62-8e93 |
| 2026-08-16 09:29:45 | agent_float_settlement | production | cash_out | 100 | -4,198,771 | none | Telecom sending charge for merchant cash-out c2d1a5fe-7b4f-4e62-8e93-5 |
| 2026-08-16 14:17:25 | agent_float_settlement | production | cash_out | 107,000 | -4,305,771 | none | Company float used to settle customer cash-out 40d3c087-20e8-41a0-95a2 |
| 2026-08-16 14:17:25 | agent_float_settlement | production | cash_out | 1,000 | -4,306,771 | none | Telecom sending charge for merchant cash-out 40d3c087-20e8-41a0-95a2-a |
| 2026-08-16 14:21:52 | agent_float_settlement | production | cash_out | 5,200 | -4,311,971 | none | Company float used to settle customer cash-out 25905987-007f-4b87-98e0 |
| 2026-08-16 14:21:52 | agent_float_settlement | production | cash_out | 500 | -4,312,471 | none | Telecom sending charge for merchant cash-out 25905987-007f-4b87-98e0-2 |
| 2026-08-16 15:45:30 | agent_float_settlement | production | cash_out | 9,000 | -4,321,471 | none | Company float used to settle customer cash-out 3f20389c-ae3b-47af-a253 |
| 2026-08-16 15:45:30 | agent_float_settlement | production | cash_out | 500 | -4,321,971 | none | Telecom sending charge for merchant cash-out 3f20389c-ae3b-47af-a253-9 |
| 2026-08-16 16:10:35 | agent_float_settlement | production | cash_out | 6,600 | -4,328,571 | none | Company float used to settle customer cash-out bc191074-4669-4272-af37 |
| 2026-08-16 16:10:35 | agent_float_settlement | production | cash_out | 500 | -4,329,071 | none | Telecom sending charge for merchant cash-out bc191074-4669-4272-af37-7 |
| 2026-08-16 17:54:55 | agent_float_settlement | production | cash_out | 10,000 | -4,339,071 | none | Company float used to settle customer cash-out 5081f52f-f028-4f4f-981a |
| 2026-08-16 17:54:55 | agent_float_settlement | production | cash_out | 500 | -4,339,571 | none | Telecom sending charge for merchant cash-out 5081f52f-f028-4f4f-981a-b |
| 2026-08-16 17:58:29 | agent_float_settlement | production | cash_out | 6,972 | -4,346,543 | none | Company float used to settle customer cash-out 85960200-068c-4cbf-bf34 |
| 2026-08-16 17:58:29 | agent_float_settlement | production | cash_out | 500 | -4,347,043 | none | Telecom sending charge for merchant cash-out 85960200-068c-4cbf-bf34-5 |
| 2026-08-16 22:02:14 | agent_float_settlement | production | cash_out | 5,500 | -4,352,543 | none | Company float used to settle customer cash-out b080ea6e-186a-4e45-8358 |
| 2026-08-16 22:02:14 | agent_float_settlement | production | cash_out | 500 | -4,353,043 | none | Telecom sending charge for merchant cash-out b080ea6e-186a-4e45-8358-b |

Raw ledger net after trace: **UGX -4,353,043** vs wallet cache **UGX 646,957** → clamp/variance **UGX 5,000,000**
Final running balance from the column above: **UGX -4,353,043** — matches the stated raw ledger net after trace.

## Level 3 — What each desk actually had: post-top-up vs now

Running balance the instant after the 14-Aug top-up credits posted (last credit before the
first 17:03 sweep reversal), against the position at the close of the trace window
(2026-08-16 23:59:59 EAT). "Now (raw ledger)" is the final running-balance figure from the
Level 2 tables; "Now (wallet cache)" is the displayed float balance, floored at zero.

| Desk | Balance right after 14-Aug top-up | Now (raw ledger running balance) | Now (wallet cache, clamped) |
|---|---:|---:|---:|
| Babrah Tusingwire | 2,000,000 | -44,114 | 1,955,886 |
| Bayo Mercy | -12,705,000 | -24,025,000 | 18,415,000 |
| Catherine Nabaggala | -1,711,845 | -3,725,245 | 1,988,092 |
| Hilary Evanz | 7,003,500 | -5,152,101 | 1,847,899 |
| JOSHUA WANDA | 3,016,200 | -3,688,910 | 43,800 |
| MULUNGI AIDAH | -3,503,167 | -3,531,667 | 537,633 |
| Mudumba samuel | 2,395,669 | 2,208,633 | 2,208,633 |
| NABBALE CLAIRE | 5,000,000 | -3,854,703 | 1,145,297 |
| NAMULINDWA IMMECULATE | -8,988,596 | -9,281,646 | 1,743,954 |
| Nakajjubi Shamirah | 1,968,748 | 1,968,748 | 1,968,748 |
| Nankambo sharimah | 5,607,319 | -392,681 | 4,810,319 |
| Tugabirwe Apophia | 5,000,000 | -4,353,043 | 646,957 |
| **TOTAL** | **5,082,828** | **-53,871,729** | **37,312,218** |

Notes on this table (no classifications changed):
- Every desk's final Level 2 running balance equals the "Raw ledger net after trace" already
  stated in that desk's section — no per-desk mismatch findings arose.
- Desks whose post-top-up balance is already negative (Bayo Mercy, Catherine Nabaggala,
  MULUNGI AIDAH, NAMULINDWA IMMECULATE) were carrying a pre-14-Aug negative raw net; the
  top-up did not clear it.
- The gap between column 3 and column 4 is the clamp artifact plus asserted-only credits
  already itemised in Level 1; it is not spendable cash.

