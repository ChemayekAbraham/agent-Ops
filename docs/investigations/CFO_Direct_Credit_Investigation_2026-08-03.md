# Investigation Report — CFO Direct Credit Analysis (Reporting day 2026-08-03)

**Status: READ-ONLY.** No wallet, ledger entry, projection, report, edge function, RPC, classification or business record was modified during this investigation. Every statement below comes from `SELECT`-only queries against `general_ledger`, `audit_logs`, `wallets`, `v_user_wallet_strict`, `float_requests`, `employee_requisitions`, `profiles`, `user_roles`, plus reads of `supabase/functions/generate-daily-wallet-report/index.ts` and `supabase/functions/cfo-direct-credit/index.ts`.

---

## 1. Executive Summary

| Item | Finding |
|---|---|
| Reporting window | `2026-08-02T21:00:00Z` → `2026-08-03T21:00:00Z` (EAT day 2026-08-03) |
| Report figure | 39 transactions, UGX 174,172,998 |
| Verified figure (report definition) | **39 transactions, UGX 174,172,998 — reproduced exactly** |
| True CFO Direct Credit volume | **45 credits, UGX 175,820,626** (6 credits, UGX 1,647,628, are excluded by the report's category filter) |
| Same-day CFO Direct **Debits** (same tool, opposite direction) | 4 legs, UGX 8,945,500 — not shown anywhere on the report |
| Earliest / latest credit | 09:12 EAT / 22:38 EAT |
| Double-entry integrity | ✅ Cash In == Cash Out on all 45 groups (and on the 4 debits) |
| Wallet visibility | ✅ All 45 credits reached ledger → projection → cache → strict view. 1 wallet shows cache drift (Sharif Kc) |
| Authorization | ✅ All 7 operators hold `cfo`/`super_admin` at posting time |
| Duplicates | ⚠️ 4 recipient+amount repeat pairs and 1 duplicate-identity double payment |
| Classification | ⚠️ UGX 84.85M booked to `general_admin_expense / office_rent` that is demonstrably **agent working capital**, not office rent |
| Net verdict | No unauthorized credit, no treasury leak, no broken double entry. Material **classification** and **reporting-completeness** defects, plus 5 credits needing business confirmation |

### What a "CFO Direct Credit" actually is on this report

`compute_wallet_report` (called by `generate-daily-wallet-report`) counts a transaction as **CFO Direct Credit** only when:

```
gl.direction    = 'cash_in'
gl.ledger_scope = 'wallet'
gl.source_table = 'cfo_direct_credit'
gl.category    IN ('wallet_deposit', 'agent_float_deposit')
```

That last line is the whole reason the report says 39 instead of 45.

---

## 2. Transaction Inventory (all 45)

Rows marked *(excluded from report bucket)* are genuine CFO Direct Credits that the report does not count.

| # | Time (EAT) | Reference | Amount UGX | Recipient | Recip. type | Bucket | Accounting category | Sub | Operator | Description |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-08-03 07:11 (UTC) | PAY-MSCW4WOE-H8EK | 40,000 | Sharif Kc | user | withdrawable | agent_commission_earned | - | Bayo Mercy | (excluded from report bucket) |
| 2 | 2026-08-03 09:12 | PAY-MSCU12D3-G80E | 150,000 | Tumwiine Collines | user | withdrawable | wallet_deposit | - | Bayo Mercy | Welile Technologies Finance [🏢 Operational Expenses → Internet] → inte |
| 3 | 2026-08-03 10:34 | PAY-MSCWYAEB-OPJQ | 150,000 | COLLINES TUMWIINE | user | withdrawable | wallet_deposit | - | Bayo Mercy | Welile Technologies Finance [🏢 Operational Expenses → Internet] → inte |
| 4 | 2026-08-03 11:09 | PAY-MSCY7T1K-A5I0 | 470,000 | Bonny Lutta | user | withdrawable | wallet_deposit | - | Kabahuma Lillian | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 5 | 2026-08-03 13:07 | PAY-MSD2EPZ4-MD1W | 1,000,000 | Mudumba samuel | operational_wallet | float | agent_float_deposit | - | Bayo Mercy | Welile Technologies Finance [Agent Float Allocation]: Agent Float Allo |
| 6 | 2026-08-03 13:22 (UTC) | PAY-MSD9DJES-IB2Z | 7,628 | MBABAZI ROBERT | user | withdrawable | agent_commission_earned | - | Nankambo sharimah | (excluded from report bucket) |
| 7 | 2026-08-03 13:55 | PAY-MSD45K1C-2EWJ | 720,000 | Hilary Evanz | operational_wallet | float | agent_float_deposit | - | JOSHUA WANDA | Welile Technologies Finance [Agent Float Allocation]: Agent Float Allo |
| 8 | 2026-08-03 13:56 | PAY-MSD45PKW-HLE6 | 20,000,000 | MBABAZI ROBERT | operational_wallet | float | agent_float_deposit | - | JOSHUA WANDA | Welile Technologies Finance [Agent Float Allocation]: Agent Float Allo |
| 9 | 2026-08-03 14:19 | PAY-MSD4ZDT5-3J76 | 3,000,000 | Mudumba samuel | operational_wallet | float | agent_float_deposit | - | Nankambo sharimah | Welile Technologies Finance [Agent Float Allocation]: Agent Float Allo |
| 10 | 2026-08-03 14:26 (UTC) | PAY-MSDBNV7X-UML7 | 150,000 | Mugasha Isaac | user | withdrawable | agent_commission_earned | - | Nankambo sharimah | (excluded from report bucket) |
| 11 | 2026-08-03 14:27 (UTC) | PAY-MSDBQ6Q0-UL2D | 420,000 | LUYIMA SOLOMON SAMUEL | user | withdrawable | agent_commission_earned | - | Nankambo sharimah | (excluded from report bucket) |
| 12 | 2026-08-03 14:28 (UTC) | PAY-MSDBRGD7-IYB1 | 1,000,000 | Mutebi Daniel | user | withdrawable | agent_commission_earned | - | Nankambo sharimah | (excluded from report bucket) |
| 13 | 2026-08-03 14:43 | PAY-MSD5UNTF-DFQ9 | 20,000,000 | Catherine Nabaggala | operational_wallet | float | agent_float_deposit | - | Bayo Mercy | Welile Technologies Finance [Agent Float Allocation]: Agent Float Allo |
| 14 | 2026-08-03 14:43 | PAY-MSD5USCM-RORP | 20,000,000 | NAMULINDWA IMMECULATE | operational_wallet | float | agent_float_deposit | - | Bayo Mercy | Welile Technologies Finance [Agent Float Allocation]: Agent Float Allo |
| 15 | 2026-08-03 14:46 (UTC) | PAY-MSDCEPY0-0NQ2 | 30,000 | MBABAZI ROBERT | user | withdrawable | agent_commission_earned | - | Nankambo sharimah | (excluded from report bucket) |
| 16 | 2026-08-03 14:48 | PAY-MSD61I7I-3LA0 | 3,000,000 | Nankambo sharimah | operational_wallet | float | agent_float_deposit | - | Bayo Mercy | Welile Technologies Finance [Agent Float Allocation]: Agent Float Allo |
| 17 | 2026-08-03 14:49 | PAY-MSD6211G-RN6U | 5,000,000 | KARUNGI ANNET | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 18 | 2026-08-03 14:50 | PAY-MSD63CBW-OU27 | 6,000,000 | WAKABI SIMON PETER | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 19 | 2026-08-03 14:51 | PAY-MSD651A3-6OJ2 | 39,998 | Muwanguzi Gideon | user | withdrawable | wallet_deposit | - | Bayo Mercy | Welile Technologies Finance [🏢 Operational Expenses → Transport] → tra |
| 20 | 2026-08-03 14:53 | PAY-MSD67EQ3-W040 | 20,000,000 | NAMPIIMA RUTH | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 21 | 2026-08-03 14:54 | PAY-MSD68ISP-84TR | 2,500,000 | elisha maling | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 22 | 2026-08-03 14:55 | PAY-MSD69QR4-ASF0 | 1,000,000 | Bisaso Aaron | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 23 | 2026-08-03 14:55 | PAY-MSD6ADH2-I0L2 | 1,000,000 | NANGOLI HELLEN | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 24 | 2026-08-03 14:56 | PAY-MSD6BDCD-D49P | 200,000 | CHELANGAT SARAH | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 25 | 2026-08-03 15:26 | PAY-MSD7DKAJ-4NR7 | 3,000,000 | Hilary Evanz | operational_wallet | float | agent_float_deposit | - | Bayo Mercy | Welile Technologies Finance [Agent Float Allocation]: Agent Float Allo |
| 26 | 2026-08-03 15:56 | PAY-MSD8GV0Z-IFB5 | 613,000 | NASASIRA FAITH DAVID | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 27 | 2026-08-03 16:01 | PAY-MSD8MHBB-ODJK | 1,500,000 | KALULE SHARIF | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 28 | 2026-08-03 16:03 | PAY-MSD8PPC9-MQW8 | 3,000,000 | victoria nakitto | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 29 | 2026-08-03 16:05 | PAY-MSD8S4ZH-BTA7 | 90,000 | Watsala Enock | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 30 | 2026-08-03 16:15 | PAY-MSD94R6V-7FHH | 10,000,000 | MBABAZI ROBERT | operational_wallet | float | agent_float_deposit | - | Bayo Mercy | Welile Technologies Finance [Agent Float Allocation]: Agent Float Allo |
| 31 | 2026-08-03 16:15 | PAY-MSD94RA8-KDJM | 470,000 | Bonny Lutta | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 32 | 2026-08-03 16:19 | PAY-MSD9AUI1-040L | 24,500,000 | ALLEN NDYANABO | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 33 | 2026-08-03 16:20 | PAY-MSD9BTEN-LCNR | 1,500,000 | BRENDAN JOSEPH LULE | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 34 | 2026-08-03 16:22 | PAY-MSD9DWNS-C576 | 500,000 | NASSANGA WINNIE | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 35 | 2026-08-03 16:22 | PAY-MSD9ECAO-IFN4 | 90,000 | Ssekabembe Kenneth Derrick Dalaa | user | withdrawable | wallet_deposit | - | Kabahuma Lillian | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 36 | 2026-08-03 16:23 | PAY-MSD9FK79-A28B | 420,000 | LUYIMA SOLOMON SAMUEL | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 37 | 2026-08-03 16:30 | PAY-MSD9OPFM-D79Q | 1,000,000 | Mutebi Daniel | user | withdrawable | wallet_deposit | - | Kabahuma Lillian | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 38 | 2026-08-03 16:42 | PAY-MSDA39PB-04GO | 100,000 | LWEGABA ENOCK EUGINE | user | withdrawable | wallet_deposit | - | RODGERS | Welile Technologies Finance [Requisition Credit] → Office Supplies: Re |
| 39 | 2026-08-03 16:42 | PAY-MSDA3E5Y-4V6E | 160,000 | Grace Paul Ochieng | user | withdrawable | wallet_deposit | - | RODGERS | Welile Technologies Finance [Requisition Credit] → Travel: Requisition |
| 40 | 2026-08-03 16:43 | PAY-MSDA5H87-39NI | 1,200,000 | JOSHUA WANDA | user | withdrawable | wallet_deposit | - | Benjamin Muhanguzi | Welile Technologies Finance [🔬 Research & Development → Software] → so |
| 41 | 2026-08-03 16:54 | PAY-MSDAJ4O8-UGQP | 2,000,000 | TUMUGABIRWE BIBIAN | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 42 | 2026-08-03 16:55 | PAY-MSDAL3AE-RVBI | 3,000,000 | Tugabirwe Apophia | operational_wallet | float | agent_float_deposit | - | Bayo Mercy | Welile Technologies Finance [Agent Float Allocation]: Agent Float Allo |
| 43 | 2026-08-03 17:03 | PAY-MSDAUESD-29R6 | 13,000,000 | OKWIR SAMUEL | user | withdrawable | wallet_deposit | - | ATUHAIRE CAROLYNE | Welile Technologies Finance [🏢 Operational Expenses → Office Rent] → o |
| 44 | 2026-08-03 17:13 | PAY-MSDB7CLQ-7HV9 | 800,000 | JOSHUA WANDA | user | withdrawable | wallet_deposit | - | Benjamin Muhanguzi | Welile Technologies Finance [🔬 Research & Development → Software] → so |
| 45 | 2026-08-03 19:38 | PAY-MSDGDQAS-CUJA | 3,000,000 | Mudumba samuel | operational_wallet | float | agent_float_deposit | - | Bayo Mercy | Welile Technologies Finance [Agent Float Allocation]: Agent Float Allo |
---

## 3. Classification Analysis (Phase 3)

Every credit was posted by the same tool (`cfo-direct-credit` edge function, `operation: 'credit'`). What differs is the accounting category the operator picked in the UI.

| Accounting category | Sub-category | Count | Amount UGX | Real-world nature |
|---|---|---|---|---|
| `agent_float_deposit` | — | 11 | 86,720,000 | **Agent / merchant float top-ups** against approved `float_requests` |
| `general_admin_expense` | `office_rent` | 21 | 84,853,000 | **Mostly agent working capital / payout funding**, mislabeled |
| `general_admin_expense` | `internet` | 2 | 300,000 | Welile School internet payments to two staff wallets |
| `general_admin_expense` | `transport` | 1 | 39,998 | Genuine transport reimbursement |
| `research_development_expense` | `software` | 2 | 2,000,000 | Genuine R&D/software spend |
| `payroll_expense` | `Office Supplies` / `Travel` | 2 | 260,000 | Requisition reimbursements (`employee_requisitions` `ea4a553a…`, `3890fac6…`, both `paid`) |
| `agent_commission_earned` | — | 6 | 1,647,628 | Manual commission corrections — **invisible on the report** |
| **Total** | | **45** | **175,820,626** | |

Mapped onto your requested taxonomy: Agent/Merchant Float 86.72M · Manual Adjustment / Working Capital 84.85M · Commission 1.65M · Operational Expense 0.34M · R&D 2.00M · Requisition/Employee Payment 0.26M · Payroll 0 · Standing Order 0 · Error Correction 0 (all same-day error corrections were **debits**, see §6).

---

## 4. Source of Funds (Phase 4)

All 45 credits are funded the same way, and it is structurally valid: the tool posts a balanced pair where the **platform leg is the funding source**.

| Funding source (platform leg category) | Count | Amount UGX | Valid source? |
|---|---|---|---|
| `agent_float_deposit` (company float treasury) | 11 | 86,720,000 | ✅ backed by an **approved** `float_requests` row for every one of the 11 |
| `general_admin_expense` (operating expense account) | 24 | 85,192,998 | ✅ posts, but expense account is wrong for 21 of them (§11) |
| `research_development_expense` | 2 | 2,000,000 | ✅ |
| `agent_commission_earned` (commission expense) | 6 | 1,647,628 | ✅ |
| `payroll_expense` | 2 | 260,000 | ✅ tied to `paid` employee requisitions |

**No credit was funded from thin air.** There is no `cash_in` wallet leg on this day whose group lacks a platform `cash_out` counter-leg.

Float requisition trace (the 11 float credits), all `status = approved` with a non-null `approved_by`:

| float_request | Agent | Requested UGX | Reason | Approved by |
|---|---|---|---|---|
| `b889d7c2…` | Mudumba samuel | 1,000,000 | More float | Bayo Mercy |
| `615f9986…` | Hilary Evanz | 720,000 | Payout | JOSHUA WANDA |
| `2aebb46d…` | Mudumba samuel | 3,000,000 | High cash out volume | Nankambo sharimah |
| `955afaea…` | MBABAZI ROBERT | 20,000,000 | Payout | JOSHUA WANDA |
| `d3fec2ff…` | Catherine Nabaggala | 20,000,000 | Float | Bayo Mercy |
| `1d04a384…` | NAMULINDWA IMMECULATE | 20,000,000 | Float | Bayo Mercy |
| `14f25775…` | Nankambo sharimah | 3,000,000 | float | Bayo Mercy |
| `6090790a…`, `02ef7263…`, `80b1fe8c…`, `05797696…` | (remaining four) | balance to 86.72M | float/payout | CFO-role approvers |

⚠️ Governance note: `2aebb46d…` (3,000,000 to Mudumba samuel) was approved by **Nankambo sharimah**, who is herself a float recipient the same day (`14f25775…`). She holds `cfo` so the check passes, but this is peer-to-peer float approval inside the same day.

---

## 5. Destination Analysis (Phase 5) — Wallet Routing v2

| Destination bucket | Count | Amount UGX | Recipient type | Routing verdict |
|---|---|---|---|---|
| `withdrawable` | 34 | 89,100,626 | `user` | ✅ correct per Routing v2 (`user` → withdrawable) |
| `float_balance` | 11 | 86,720,000 | `operational_wallet` | ✅ correct per Routing v2 (`operational_wallet` → float) |
| `advance_balance` | 0 | 0 | — | none |
| `restricted` | 0 | 0 | — | none |

`routing_source` on every row reads `cfo_direct_credit_explicit_bucket`, i.e. the bucket was set explicitly by the tool and then confirmed by the `trg_set_wallet_bucket_from_recipient_type` / `enforce_recipient_routing` path. **Zero rows in `wallet_routing_violations` for this window.**

By recipient role: 29 of 35 distinct recipients are agent/landlord/supporter field accounts; 4 are staff (`employee`) wallets; 2 are pure `supporter` wallets (Bisaso Aaron 1,000,000 and Bonny Lutta 940,000 — credited to `withdrawable` as "office_rent", see §11).

---

## 6. Ledger Verification (Phase 6)

All `source_table = 'cfo_direct_credit'` legs in the window:

| Direction | Category | Bucket | Count | UGX |
|---|---|---|---|---|
| cash_in | wallet_deposit | withdrawable | 28 | 87,452,998 |
| cash_in | agent_float_deposit | float | 11 | 86,720,000 |
| cash_in | agent_commission_earned | withdrawable | 6 | 1,647,628 |
| cash_in | system_balance_correction | (platform) | 4 | 8,945,500 |
| cash_out | agent_float_deposit | (platform) | 11 | 86,720,000 |
| cash_out | general_admin_expense | (platform) | 24 | 85,192,998 |
| cash_out | research_development_expense | (platform) | 2 | 2,000,000 |
| cash_out | agent_commission_earned | (platform) | 6 | 1,647,628 |
| cash_out | payroll_expense | (platform) | 2 | 260,000 |
| cash_out | system_balance_correction | float/withdrawable | 4 | 8,945,500 |

**Cash In = 184,766,126 = Cash Out.** ✅ Perfectly balanced. Every group has exactly one wallet-scope leg and one platform-scope leg. **No imbalance found.**

The 4 `system_balance_correction` pairs are **CFO Direct Debits** (`operation: 'debit'`, wallet → platform, UGX 8,945,500: 7,525,500 out of float, 1,420,000 out of withdrawable) issued through the same edge function on the same day. They are legitimate and correctly posted, but the Daily Wallet Financial Summary shows **only the credit side of the CFO tool**, so the report overstates the day's net CFO activity by 8,945,500.

---

## 7. Wallet Verification (Phase 7)

Chain checked per recipient: `general_ledger` → wallet projection → `wallets` cache → `v_user_wallet_strict` → `get_user_available_balance` (the value the dashboard renders).

- 35 distinct recipient wallets checked.
- **34 of 35: cache == strict on every bucket.** No credit stopped mid-chain.
- **1 exception — Sharif Kc** (`98ee118b…`): cache `withdrawable` 202,428 vs strict 186,854 → **UGX 15,574 cache inflation**. This predates today's 40,000 commission credit; it is the known anchored-cache drift class, not a lost credit.
- Many recipients now show 0.00 across buckets. That is expected: these are field float/payout wallets that were paid out or allocated onward after the credit; the day's credits are visible in the statement history.
- Two wallets carry `pending_holds` that suppress visible balance: **OKWIR SAMUEL** 1,600,000 and **Grace Paul Ochieng** 85,000. Related to the stale-hold class already tracked in the CFO reconciliation queue.

---

## 8. Duplicate Analysis (Phase 8)

No duplicate `id`, no duplicate `transaction_group_id`, no duplicate `reference_id`, no duplicate `idempotency_key`. Duplication risk here is **behavioural** (operator posted twice), not technical.

| Recipient | Amount UGX | Credit 1 | Credit 2 | Assessment |
|---|---|---|---|---|
| Bonny Lutta | 470,000 ×2 | `PAY-MSCY7T1K-A5I0` 11:09 | `PAY-MSD94RA8-KDJM` 16:15 | ⚠️ Same amount, same "office_rent / newaccount" wording, 5 h apart — **confirm intent** |
| LUYIMA SOLOMON SAMUEL | 420,000 ×2 | `PAY-MSD9FK79-A28B` 16:23 (wallet_deposit) | `PAY-MSDBQ6Q0-UL2D` 17:27 (agent_commission_earned) | ⚠️ Same amount, different category 1 h apart — **confirm intent** |
| Mutebi Daniel | 1,000,000 ×2 | `PAY-MSD9OPFM-D79Q` 16:30 (wallet_deposit) | `PAY-MSDBRGD7-IYB1` 17:28 (agent_commission_earned) | ⚠️ Same pattern as above — **confirm intent** |
| Mudumba samuel | 3,000,000 ×2 | `PAY-MSD4ZDT5-3J76` 14:19 | `PAY-MSDGDQAS-CUJA` 19:38 | Both map to distinct approved float requests (`2aebb46d…` + one other) — likely legitimate |
| Tumwiine Collines / COLLINES TUMWIINE | 150,000 ×2 | `PAY-MSCU12D3-G80E` 09:12 → `5d593d07…` | `PAY-MSCWYAEB-OPJQ` 10:34 → `74a8bebe…` | 🔴 **Same human, two profiles, identical description "Welile School Internet"** — this is a duplicate-identity double payment of the same obligation |
| MBABAZI ROBERT | 4 credits (20M float + 3 commission corrections incl. 7,628 and 30,000) | | | Float tied to `955afaea…`; the three micro-corrections are consistent with reconciliation, not duplication |

The **LUYIMA / Mutebi** pattern is the one I would escalate first: the second credit is the same round amount as the first but re-categorised as commission, which is the signature of "the first post didn't show up where I expected, so I posted it again under a different category."

---

## 9. Authorization Review (Phase 9)

Every credit carries an `audit_logs` row (45/45) naming the operator; the edge function resolves the actor from the bearer token, so operator attribution is trustworthy.

| Operator | Credits | Amount UGX | Roles held |
|---|---|---|---|
| ATUHAIRE CAROLYNE | 18 | 83,293,000 | `coo, ceo, cfo, super_admin, partner_ops, operations, manager…` |
| Bayo Mercy | 12 | 63,379,998 | `cfo, super_admin, agent_ops, tenant_ops, landlord_ops, partner_ops, hr…` |
| JOSHUA WANDA | 2 | 20,720,000 | `cfo, cto, super_admin, manager…` |
| Nankambo sharimah | 6 | 4,607,628 | `cfo, coo, cto, super_admin, operations…` |
| Benjamin Muhanguzi | 2 | 2,000,000 | `cfo, cto, cmo, ceo, coo, super_admin, access_admin…` |
| Kabahuma Lillian | 3 | 1,560,000 | `ceo, coo, cfo, partner_ops, operations…` |
| RODGERS | 2 | 260,000 | `manager, agent, landlord, tenant` |

- No `system`, `scheduler`, `standing order` or `unknown` actor. **Zero automated CFO Direct Credits** — all 45 were human-initiated.
- ✅ All operators satisfied the function's authorization gate.
- ⚠️ **Role over-grant is the real exposure**: 6 of 7 operators hold `cfo` *plus* `ceo`/`coo`/`super_admin` simultaneously, which collapses the CFO/FinOps separation-of-powers rule. RODGERS holds only `manager` yet appears as operator on 2 payroll credits — worth confirming the gate treated `manager` as permitted rather than a `cfo` grant that has since been revoked.
- ⚠️ **Duplicate operator identities**: ATUHAIRE CAROLYNE has 3 profiles, Benjamin Muhanguzi has 3. Only one of each carries executive roles. This is the same identity-duplication defect that caused the Tumwiine Collines double payment in §8.

---

## 10. Business Rule Compliance (Phase 10)

| Check | Result |
|---|---|
| Correct ledger routing (wallet leg + platform leg, scoped) | ✅ 45/45 |
| Double entry maintained (Cash In == Cash Out) | ✅ 45/45 (+ 4 debits) |
| Correct wallet bucket vs `recipient_type` (Routing v2) | ✅ 45/45, zero routing violations |
| Correct recipient type stamped | ✅ 45/45 (`user` or `operational_wallet`) |
| Valid funding source on platform leg | ✅ 45/45 |
| Wallet projection updated | ✅ 45/45 |
| Strict wallet / dashboard updated | ✅ 34/35 wallets clean; 1 cache drift (Sharif Kc, 15,574) |
| Audit log written with actor + reason | ✅ 45/45 |
| **Correct accounting category** | ❌ **21 credits (84,853,000) booked to `general_admin_expense / office_rent` that are not office rent** |
| **Complete reporting** | ❌ 6 credits (1,647,628) omitted; 4 debits (8,945,500) omitted |

---

## 11. Financial Integrity & Risk Assessment (Phase 11)

| Risk | Present? | Detail |
|---|---|---|
| Unauthorized credit | ❌ No | All 45 authorized, audited, attributed |
| Treasury leak | ❌ No | Every credit has a balanced funding leg |
| Broken double entry | ❌ No | Cash In == Cash Out exactly |
| Wallet bucket error / float leak to withdrawable | ❌ No | Routing v2 clean on all 45 |
| Commission inflation | ⚠️ Low-Med | 6 manual `agent_commission_earned` credits (1,647,628) bypass the commission engine and are invisible on the daily report — inflation would not be caught by the report |
| Duplicate credit | ⚠️ Medium | 3 pairs need business confirmation; 1 confirmed duplicate-identity double payment (150,000) |
| **Expense misclassification** | 🔴 **High** | 84,853,000 of agent working capital sits in the P&L as **Office Rent**. If reported as-is, monthly admin expense is overstated by ~85M and float/working-capital deployment is understated by the same amount. This is a financial-statement-level misstatement, not a wallet bug |
| Payroll duplication | ❌ No | Only 2 payroll-tagged credits, both tied to `paid` requisitions |
| Standing-order duplication | ❌ No | No standing orders in this set |
| Manual-fraud surface | ⚠️ Medium | 100% human-initiated, 84.85M of it under a free-text "office_rent" label, executed by operators holding CFO+CEO+COO+super_admin simultaneously, one of whom approved a float request for a peer while receiving her own |

Evidence that the "office_rent" bucket is misclassified: the recipients are field agent/landlord/supporter wallets (NAMPIIMA RUTH 20,000,000; ALLEN NDYANABO 24,500,000; OKWIR SAMUEL 13,000,000), and the free-text descriptions read "newaccount", "CREDIT ACC", "top up" — payout funding language, not rent. Genuine landlords do not receive rent as a `withdrawable` wallet credit tagged `general_admin_expense`.

---

## 12. Reporting Accuracy (Phase 12)

**The report's 39 / 174,172,998 is arithmetically correct for its own definition, and materially incomplete as a picture of CFO Direct Credit activity.**

1. **Missing (6 credits, UGX 1,647,628).** `compute_wallet_report` filters `category IN ('wallet_deposit','agent_float_deposit')`. Six credits were categorised `agent_commission_earned` and therefore vanish from the CFO Direct Credit line: `PAY-MSCW4WOE-H8EK`, `PAY-MSD9DJES-IB2Z`, `PAY-MSDBNV7X-UML7`, `PAY-MSDBQ6Q0-UL2D`, `PAY-MSDBRGD7-IYB1`, `PAY-MSDCEPY0-0NQ2`. Two of those six are exactly the suspected duplicate re-posts in §8 — the very rows an exception report most needs to surface.
2. **Missing (4 debits, UGX 8,945,500).** CFO Direct **Debits** share `source_table = 'cfo_direct_credit'` but are `system_balance_correction` and the opposite direction. The report has no CFO Direct Debit line at all, so the reader cannot see net CFO movement.
3. **Should not sit under one label (21 credits, UGX 84,853,000).** These belong under a float / working-capital line, not the same generic bucket as genuine expenses — the label hides the single largest money movement of the day behind "office rent".
4. **No misattributed transactions found.** Nothing counted under CFO Direct Credit was posted by a different tool; `source_table` is set by the edge function only.

---

## 13. Statistics (Phase 13)

**Across all 45 true credits:** total 175,820,626 · mean 3,907,125 · median 1,000,000 · min 7,628 (MBABAZI ROBERT, commission correction) · max 24,500,000 (ALLEN NDYANABO, "office_rent").

**By bucket:** withdrawable 34 / 89,100,626 · float 11 / 86,720,000.

**By operator:** see §9 table (ATUHAIRE CAROLYNE and Bayo Mercy together = 30 credits, UGX 146,672,998 = 83% of the day's value).

**Largest six:** 24,500,000 ALLEN NDYANABO · 20,000,000 MBABAZI ROBERT (float) · 20,000,000 Catherine Nabaggala (float) · 20,000,000 NAMULINDWA IMMECULATE (float) · 20,000,000 NAMPIIMA RUTH (office_rent) · 13,000,000 OKWIR SAMUEL (office_rent).

**Smallest four:** 7,628 · 30,000 (both MBABAZI ROBERT commission) · 39,998 Muwanguzi Gideon (transport) · 40,000 Sharif Kc (commission).

**By day:** the entire set falls on 2026-08-03, concentrated 09:12–22:38 EAT, with the float wave clustered 14:00–16:30 immediately after the 10:00–11:50 float-request approvals.

**Recipient concentration:** top 6 recipients absorb ~68% of the value; 35 distinct recipient wallets in total.

---

## 14. Root Cause Analysis (Phase 14)

**Why 39?** Because the report's CFO Direct Credit definition is a category allowlist (`wallet_deposit`, `agent_float_deposit`) rather than a tool filter (`source_table = 'cfo_direct_credit'`). Six commission-categorised credits fall outside the allowlist. The count is a filtering artefact, not a missing transaction.

**Why UGX 174,172,998?** 87,452,998 of `wallet_deposit` credits + 86,720,000 of `agent_float_deposit` credits. The float half is fully explained by 11 approved `float_requests` raised and approved that morning (a heavy cash-out day). The `wallet_deposit` half is dominated by 21 large "office_rent"-labelled working-capital credits to field wallets.

**Is that total expected?** For a day with 86.72M of approved float requests, yes on the float side. The 84.85M "office_rent" side is **not** expected as an expense figure — it is expected as float/working capital that was booked to the wrong account.

**Is every credit legitimate?** Every credit is authorized, funded, balanced and delivered. Legitimacy of *purpose* is confirmed for 39; 5 require business confirmation: the 3 same-amount repeat pairs, the Tumwiine Collines duplicate-identity payment, and the 6 off-report commission corrections as a class.

---

## 15. Blast Radius

| Surface | Impact |
|---|---|
| Wallet balances | None. No inflation, no loss, no bucket leak (1 pre-existing 15,574 cache drift) |
| General ledger | Intact. Double entry holds on every group |
| P&L / management accounts | 🔴 Admin expense overstated ~84.85M for the month; float deployment understated by the same |
| Daily Wallet Financial Summary | Understates CFO Direct Credit by 1,647,628 / 6 txns; omits 8,945,500 of CFO Direct Debits |
| Exception detection | Blind spot: manual commission credits and all CFO debits escape the daily report — this is how a duplicate re-post would go unnoticed |
| Cash / treasury | No leak identified |
| Users affected | 35 recipient wallets; 1 recipient (Tumwiine Collines) paid twice for one obligation across two profiles |
| Governance | CFO/CEO/COO/super_admin role collapse across 6 operators; peer float approval; duplicate executive identities |

---

## 16. Recommendations (NOT IMPLEMENTED)

1. **Redefine the report bucket.** Classify CFO Direct Credit by `source_table = 'cfo_direct_credit' AND direction = 'cash_in'`, and break it out by accounting category as sub-lines. Removes the 39-vs-45 gap permanently.
2. **Add a "CFO Direct Debit" line** to the Daily Wallet Financial Summary so net CFO movement is visible.
3. **Stop `office_rent` being a catch-all.** Require a structured purpose for CFO Direct Credit to a field wallet, and route working-capital credits to a float/working-capital category instead of `general_admin_expense`. Then reclassify the 21 rows (84,853,000) via a documented adjustment.
4. **Block manual `agent_commission_earned` credits** through the CFO tool, or force them through a distinct `commission_correction` category that the daily report must show.
5. **Same-day duplicate guard.** Warn (and require a typed override reason) when the tool is about to credit the same recipient the same amount within 24 hours — this alone would have flagged Bonny Lutta, LUYIMA, and Mutebi.
6. **Cross-profile duplicate guard.** Match on national ID / phone, not `user_id`, before crediting — prevents the Tumwiine Collines / COLLINES TUMWIINE double payment class.
7. **Restore separation of powers.** No single profile should hold `cfo` + `ceo` + `coo` + `super_admin`. Forbid approving a `float_request` on any day you are yourself a float recipient.
8. **Investigate and confirm** the 5 flagged transactions with the posting operators, and confirm the Sharif Kc 15,574 cache drift through the existing anchored-cache drift panel.
9. **Threshold review.** 5 credits ≥ 13M were posted by a single operator with no second approver visible in the audit trail; consider extending the dual-approval threshold already used for error corrections to CFO Direct Credit.

---

**Confirmation:** this investigation was strictly read-only. No wallets, ledger entries, balances, projections, reports, edge functions, RPCs, financial records, classifications or business data were created, modified, reclassified or repaired.
