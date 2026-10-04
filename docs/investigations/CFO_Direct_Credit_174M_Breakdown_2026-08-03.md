# Investigation — Complete Breakdown of the UGX 174,172,998 “CFO Direct Credit” Line

**Reporting day:** 2026-08-03 (window `2026-08-02T21:00:00Z` → `2026-08-03T21:00:00Z`, i.e. EAT calendar day)

**Status: STRICTLY READ-ONLY.** No wallet, ledger entry, balance, projection, report row, edge function, RPC or database record was modified. Every figure below comes from `SELECT`-only reads of `general_ledger`, `daily_wallet_reports`, `profiles`, `user_roles`, `audit_logs`, plus source reads of `generate-daily-wallet-report` / `cfo-direct-credit`.

---

## 1. Executive Summary

### 1.1 The proposed wording in the request is factually incorrect — do not publish it

The request proposed stating that the UGX 174,172,998 is “credits **and** debits”, split as UGX 102,600,000 credits + UGX 71,572,998 debits. The data does not support this, and the two component figures do not exist anywhere in the day's ledger:

| Claim in the request | Actual database value | Verdict |
|---|---|---|
| Total includes both credits and debits | The stored report keeps `cfo_direct_credit` inside `deposits_by_source` — an **inflow-only** bucket, filtered on `direction = 'cash_in'` | ❌ False |
| Credits portion = UGX 102,600,000 | Credits inside the reported bucket = **UGX 174,172,998** (39 legs, 100% of the line) | ❌ False |
| Debits portion = UGX 71,572,998 | CFO Direct **Debits** on 2026-08-03 = **UGX 8,945,500** (4 legs) and are **excluded** from the line entirely | ❌ False |

Proof from the stored report row (`daily_wallet_reports` for 2026-08-03), verbatim:

```json
"deposits_by_source": { ... "cfo_direct_credit": { "count": 39, "amount": 174172998 } ... }
```

Proof from the ledger, same window, tool `source_table = 'cfo_direct_credit'`:

| Direction | Category | Legs | Amount UGX | In the 174,172,998? |
|---|---|---:|---:|---|
| cash_in | `wallet_deposit` | 28 | 87,452,998 | ✅ yes |
| cash_in | `agent_float_deposit` | 11 | 86,720,000 | ✅ yes |
| cash_in | `agent_commission_earned` | 6 | 1,647,628 | ❌ no — category filter drops it |
| cash_out | `system_balance_correction` (CFO Direct Debit) | 4 | 8,945,500 | ❌ no — wrong direction |
| | **Reported total** | **39** | **174,172,998** | |

### 1.2 The correct one-paragraph wording

> The UGX 174,172,998 shown under **CFO Direct Credit** is entirely **money moved out of the platform into user wallets** (Platform → Wallet). It contains no debits. It is made of two flows: **UGX 86,720,000 of agent float funding** to 8 field agents (11 allocations, credited to the non-withdrawable `float` bucket) and **UGX 87,452,998 of direct wallet credits** to 26 individuals (28 credits, `withdrawable` bucket), of which UGX 84,853,000 was posted under the accounting label “Office Rent”. Separately on the same day the CFO retracted **UGX 8,945,500** from 3 wallets using CFO Direct Debit; those retractions are **not** netted into this line, so the report overstates net CFO movement by that amount. True gross CFO Direct Credit activity was UGX 175,820,626 across 45 credits — 6 commission credits (UGX 1,647,628) fall outside the report's category filter.

### 1.3 Verdict table

| Item | Finding |
|---|---|
| Reconciliation to UGX 174,172,998 | ✅ Exact, to the shilling, on 39 legs |
| Double-entry integrity | ✅ Every group balanced: wallet `cash_in` == platform `cash_out` |
| Authorization | ✅ All 7 operators held `cfo`/`super_admin` at posting time |
| Wallet routing (v2) | ✅ All 39 routed by `recipient_type`; 0 rows in `wallet_routing_violations` |
| Classification | ⚠️ **UGX 84,853,000 (48.7%) booked to `general_admin_expense` / “Office Rent”** that is demonstrably field working capital, not rent |
| Report completeness | ⚠️ 6 credits omitted; 4 debits invisible; no CFO Direct Debit line exists |
| Unauthorized credit / treasury leak / broken entry | None found |

---

## 2. Complete Transaction Listing — the 39 legs that make the total

Times are EAT. Operator = the authenticated poster recorded in `audit_logs.action_type = 'cfo_direct_credit'`. Every row was created by the **`cfo-direct-credit` edge function** (operation `credit`), which posts through `create_ledger_transaction`; source table `cfo_direct_credit`, classification `production`.

| # | Time | Reference | Amount UGX | Recipient | Phone | User ID | Role | Bucket | Recipient type | Wallet category | Platform (expense) leg | Label / business purpose | Operator |
|---:|---|---|---:|---|---|---|---|---|---|---|---|---|---|
| 1 | 08-03 09:12 | `PAY-MSCU12D3-G80E` | 150,000 | Tumwiine Collines | +256786686225 | `5d593d07…` | Executive (CTO) | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Internet | Bayo Mercy |
| 2 | 08-03 10:34 | `PAY-MSCWYAEB-OPJQ` | 150,000 | COLLINES TUMWIINE | +256743586850 | `74a8bebe…` | Supporter | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Internet | Bayo Mercy |
| 3 | 08-03 11:09 | `PAY-MSCY7T1K-A5I0` | 470,000 | Bonny Lutta | +256773653595 | `41594d88…` | Supporter | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | Kabahuma Lillian |
| 4 | 08-03 13:07 | `PAY-MSD2EPZ4-MD1W` | 1,000,000 | Mudumba samuel | +256743401452 | `5f5847d2…` | Agent | float | operational_wallet | `agent_float_deposit` | `agent_float_deposit` | Agent Float Allocation | Bayo Mercy |
| 5 | 08-03 13:55 | `PAY-MSD45K1C-2EWJ` | 720,000 | Hilary Evanz | +256756673744 | `151d6409…` | Agent | float | operational_wallet | `agent_float_deposit` | `agent_float_deposit` | Agent Float Allocation | JOSHUA WANDA |
| 6 | 08-03 13:56 | `PAY-MSD45PKW-HLE6` | 20,000,000 | MBABAZI ROBERT | +256751237003 | `edd7aee0…` | Agent | float | operational_wallet | `agent_float_deposit` | `agent_float_deposit` | Agent Float Allocation | JOSHUA WANDA |
| 7 | 08-03 14:19 | `PAY-MSD4ZDT5-3J76` | 3,000,000 | Mudumba samuel | +256743401452 | `5f5847d2…` | Agent | float | operational_wallet | `agent_float_deposit` | `agent_float_deposit` | Agent Float Allocation | Nankambo sharimah |
| 8 | 08-03 14:43 | `PAY-MSD5UNTF-DFQ9` | 20,000,000 | Catherine Nabaggala | +256743049289 | `7f4d0676…` | Agent | float | operational_wallet | `agent_float_deposit` | `agent_float_deposit` | Agent Float Allocation | Bayo Mercy |
| 9 | 08-03 14:43 | `PAY-MSD5USCM-RORP` | 20,000,000 | NAMULINDWA IMMECULATE | +256741003567 | `27d5a08b…` | Agent | float | operational_wallet | `agent_float_deposit` | `agent_float_deposit` | Agent Float Allocation | Bayo Mercy |
| 10 | 08-03 14:48 | `PAY-MSD61I7I-3LA0` | 3,000,000 | Nankambo sharimah | +256708269084 | `59d45ad2…` | Executive (CFO) | float | operational_wallet | `agent_float_deposit` | `agent_float_deposit` | Agent Float Allocation | Bayo Mercy |
| 11 | 08-03 14:49 | `PAY-MSD6211G-RN6U` | 5,000,000 | KARUNGI ANNET | +256772535388 | `61e1d579…` | Supporter | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 12 | 08-03 14:50 | `PAY-MSD63CBW-OU27` | 6,000,000 | WAKABI SIMON PETER | +256752496997 | `e145f9f8…` | Agent | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 13 | 08-03 14:51 | `PAY-MSD651A3-6OJ2` | 39,998 | Muwanguzi Gideon | +256703406836 | `75cd0f60…` | Employee | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Transport | Bayo Mercy |
| 14 | 08-03 14:53 | `PAY-MSD67EQ3-W040` | 20,000,000 | NAMPIIMA RUTH | — | `6155034a…` | Agent | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 15 | 08-03 14:54 | `PAY-MSD68ISP-84TR` | 2,500,000 | elisha maling | +256753486659 | `8d29bb61…` | Agent | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 16 | 08-03 14:55 | `PAY-MSD69QR4-ASF0` | 1,000,000 | Bisaso Aaron | +256755213966 | `04d69be9…` | Supporter | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 17 | 08-03 14:55 | `PAY-MSD6ADH2-I0L2` | 1,000,000 | NANGOLI HELLEN | +256755835466 | `4948ae77…` | Agent | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 18 | 08-03 14:56 | `PAY-MSD6BDCD-D49P` | 200,000 | CHELANGAT SARAH | — | `598c97d7…` | Agent | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 19 | 08-03 15:26 | `PAY-MSD7DKAJ-4NR7` | 3,000,000 | Hilary Evanz | +256756673744 | `151d6409…` | Agent | float | operational_wallet | `agent_float_deposit` | `agent_float_deposit` | Agent Float Allocation | Bayo Mercy |
| 20 | 08-03 15:56 | `PAY-MSD8GV0Z-IFB5` | 613,000 | NASASIRA FAITH DAVID | +256761742493 | `d0d2e6c4…` | Supporter | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 21 | 08-03 16:01 | `PAY-MSD8MHBB-ODJK` | 1,500,000 | KALULE SHARIF | — | `3f87c1f3…` | Agent | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 22 | 08-03 16:03 | `PAY-MSD8PPC9-MQW8` | 3,000,000 | victoria nakitto | — | `947e1423…` | Supporter | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 23 | 08-03 16:05 | `PAY-MSD8S4ZH-BTA7` | 90,000 | Watsala Enock | +256750223152 | `ebf0897b…` | Agent | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 24 | 08-03 16:15 | `PAY-MSD94R6V-7FHH` | 10,000,000 | MBABAZI ROBERT | +256751237003 | `edd7aee0…` | Agent | float | operational_wallet | `agent_float_deposit` | `agent_float_deposit` | Agent Float Allocation | Bayo Mercy |
| 25 | 08-03 16:15 | `PAY-MSD94RA8-KDJM` | 470,000 | Bonny Lutta | +256773653595 | `41594d88…` | Supporter | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 26 | 08-03 16:19 | `PAY-MSD9AUI1-040L` | 24,500,000 | ALLEN NDYANABO | +256785067030 | `3377ad17…` | Agent | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 27 | 08-03 16:20 | `PAY-MSD9BTEN-LCNR` | 1,500,000 | BRENDAN JOSEPH LULE | — | `9779d5ab…` | Agent | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 28 | 08-03 16:22 | `PAY-MSD9DWNS-C576` | 500,000 | NASSANGA WINNIE | +256758480483 | `7eccef31…` | Supporter | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 29 | 08-03 16:22 | `PAY-MSD9ECAO-IFN4` | 90,000 | Ssekabembe Kenneth Derrick Dalaa | +256748787893 | `3c5bb0eb…` | Agent | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | Kabahuma Lillian |
| 30 | 08-03 16:23 | `PAY-MSD9FK79-A28B` | 420,000 | LUYIMA SOLOMON SAMUEL | +256742412977 | `22f6cdf9…` | Supporter | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 31 | 08-03 16:30 | `PAY-MSD9OPFM-D79Q` | 1,000,000 | Mutebi Daniel | +256772833680 | `5bd97ed7…` | Supporter | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | Kabahuma Lillian |
| 32 | 08-03 16:42 | `PAY-MSDA39PB-04GO` | 100,000 | LWEGABA ENOCK EUGINE | — | `d5239331…` | Agent | withdrawable | user | `wallet_deposit` | `payroll_expense` | Office Supplies | RODGERS |
| 33 | 08-03 16:42 | `PAY-MSDA3E5Y-4V6E` | 160,000 | Grace Paul Ochieng | +254733803035 | `99890a2e…` | Employee | withdrawable | user | `wallet_deposit` | `payroll_expense` | Travel | RODGERS |
| 34 | 08-03 16:43 | `PAY-MSDA5H87-39NI` | 1,200,000 | JOSHUA WANDA | +256704825473 | `cb798acb…` | Executive (CFO) | withdrawable | user | `wallet_deposit` | `research_development_expense` | Software | Benjamin Muhanguzi |
| 35 | 08-03 16:54 | `PAY-MSDAJ4O8-UGQP` | 2,000,000 | TUMUGABIRWE BIBIAN | +256701239744 | `12c1b11f…` | Supporter | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 36 | 08-03 16:55 | `PAY-MSDAL3AE-RVBI` | 3,000,000 | Tugabirwe Apophia | +256782706146 | `f7a64907…` | Agent | float | operational_wallet | `agent_float_deposit` | `agent_float_deposit` | Agent Float Allocation | Bayo Mercy |
| 37 | 08-03 17:03 | `PAY-MSDAUESD-29R6` | 13,000,000 | OKWIR SAMUEL | +256780658842 | `236ac349…` | Supporter | withdrawable | user | `wallet_deposit` | `general_admin_expense` | Office Rent | ATUHAIRE CAROLYNE |
| 38 | 08-03 17:13 | `PAY-MSDB7CLQ-7HV9` | 800,000 | JOSHUA WANDA | +256704825473 | `cb798acb…` | Executive (CFO) | withdrawable | user | `wallet_deposit` | `research_development_expense` | Software | Benjamin Muhanguzi |
| 39 | 08-03 19:38 | `PAY-MSDGDQAS-CUJA` | 3,000,000 | Mudumba samuel | +256743401452 | `5f5847d2…` | Agent | float | operational_wallet | `agent_float_deposit` | `agent_float_deposit` | Agent Float Allocation | Bayo Mercy |
| | | | **174,172,998** | **39 legs** | | | | | | | | | |

**Transaction ID / group ID map** (ledger `transaction_group_id`, for audit pull-through):

| Reference | Transaction group ID |
|---|---|
| `PAY-MSCU12D3-G80E` | `e2115853-1612-4061-b1f8-11fb9556a5fc` |
| `PAY-MSCWYAEB-OPJQ` | `8eb9c85b-c3bc-4d26-a985-c46af633dfe5` |
| `PAY-MSCY7T1K-A5I0` | `451efef1-b355-428b-8642-59aed3d1aca9` |
| `PAY-MSD2EPZ4-MD1W` | `86f240a0-371b-4976-8352-81cca1dec98e` |
| `PAY-MSD45K1C-2EWJ` | `938661f9-2c73-4706-aa06-69088c3a11f7` |
| `PAY-MSD45PKW-HLE6` | `10893153-8c38-43fc-881a-6adeec58d59c` |
| `PAY-MSD4ZDT5-3J76` | `fe15aa11-ea75-4ee4-9fc5-d87e021b60e2` |
| `PAY-MSD5UNTF-DFQ9` | `9ada5e97-4a38-469c-8a69-e0f6b61ba2e7` |
| `PAY-MSD5USCM-RORP` | `7fc9917d-0a1d-4770-97bd-90eea497c8ac` |
| `PAY-MSD61I7I-3LA0` | `3a5b21bc-d4bd-4d68-ac2c-8976f85c5344` |
| `PAY-MSD6211G-RN6U` | `ad565cc1-e921-4bbc-93b3-094e8e9e1279` |
| `PAY-MSD63CBW-OU27` | `2d1e5296-9fcd-4007-9ce2-777a33fa7ed3` |
| `PAY-MSD651A3-6OJ2` | `f6ee6e4e-df81-4df7-a7c3-3396ce5cbc45` |
| `PAY-MSD67EQ3-W040` | `40d0de2c-a84d-4ada-9dcc-b0a3cdc15ea2` |
| `PAY-MSD68ISP-84TR` | `f755ab2c-f0f4-4e8a-9c2b-cd5e213c2ce0` |
| `PAY-MSD69QR4-ASF0` | `549776a4-8a4b-4c15-817b-2ea3f20389e5` |
| `PAY-MSD6ADH2-I0L2` | `557cb475-b9c2-4ac8-b7fa-3308d387bd3b` |
| `PAY-MSD6BDCD-D49P` | `875c7efa-9742-4df9-928e-b45cde825682` |
| `PAY-MSD7DKAJ-4NR7` | `d81849c0-876e-40cf-8d06-01a148bdd878` |
| `PAY-MSD8GV0Z-IFB5` | `281eaa7f-42d4-49c5-98d6-895b95335653` |
| `PAY-MSD8MHBB-ODJK` | `38ee21eb-cc55-4add-861e-73d4a6c7a118` |
| `PAY-MSD8PPC9-MQW8` | `190e0c6f-6eb8-4bb4-86c2-b12b023b5b89` |
| `PAY-MSD8S4ZH-BTA7` | `cf9a6f32-b1bd-4e3a-93ff-6009895525fd` |
| `PAY-MSD94R6V-7FHH` | `8cd80274-9367-4377-b0ef-83d136d0e800` |
| `PAY-MSD94RA8-KDJM` | `2fcfccda-e9fb-474b-b466-a1d61826a991` |
| `PAY-MSD9AUI1-040L` | `aa7b4ac1-d3b8-495a-9c7c-b4f66a9956cb` |
| `PAY-MSD9BTEN-LCNR` | `c660a561-0551-4812-aa98-227fc9e5def1` |
| `PAY-MSD9DWNS-C576` | `ec4b9f36-92b3-42a5-ad65-970fa5a94e7a` |
| `PAY-MSD9ECAO-IFN4` | `79608818-f334-40da-91c9-573b248fe80e` |
| `PAY-MSD9FK79-A28B` | `0fe7f9c8-a649-4c10-9cd8-cd8a3c2248df` |
| `PAY-MSD9OPFM-D79Q` | `feb16db6-fceb-48c9-8936-11d86d35ae45` |
| `PAY-MSDA39PB-04GO` | `6e76493b-f1e8-40fc-a205-d15053ef1efe` |
| `PAY-MSDA3E5Y-4V6E` | `a31f0aa5-925b-47e1-86e4-74df6a6a984a` |
| `PAY-MSDA5H87-39NI` | `d6bb2be7-cd83-403c-a1b0-30332b59c0a9` |
| `PAY-MSDAJ4O8-UGQP` | `13ad6798-f2d3-4cfd-a5f7-c7d1cd062818` |
| `PAY-MSDAL3AE-RVBI` | `99b648f0-bd70-4255-9b8b-f11f7f870cb2` |
| `PAY-MSDAUESD-29R6` | `adfcbcd7-76dd-4763-b9cd-09690582add9` |
| `PAY-MSDB7CLQ-7HV9` | `449ba624-4f79-46df-800f-679f9a808fbc` |
| `PAY-MSDGDQAS-CUJA` | `d6fc1db4-2e39-4a16-87f0-3c0c98cde3c7` |

---

## 3. Category Breakdown


### 3.1 By business category (reconciles to the total)

| Group | Txns | Amount UGX | % of 174,172,998 |
|---|---:|---:|---:|
| Agent Float Funding | 11 | 86,720,000 | 49.79% |
| Manual Wallet Credits posted as “Office Rent” (see §8 — misclassified) | 21 | 84,853,000 | 48.72% |
| Operational Expenses — Software | 2 | 2,000,000 | 1.15% |
| Operational Expenses — Internet | 2 | 300,000 | 0.17% |
| Operational Expenses — Travel | 1 | 160,000 | 0.09% |
| Operational Expenses — Office Supplies | 1 | 100,000 | 0.06% |
| Operational Expenses — Transport | 1 | 39,998 | 0.02% |
| **Total** | **39** | **174,172,998** | **100.00%** |

### 3.2 By posted accounting label (as booked in the ledger description)

| Group | Txns | Amount UGX | % of 174,172,998 |
|---|---:|---:|---:|
| Agent Float Allocation | 11 | 86,720,000 | 49.79% |
| Office Rent | 21 | 84,853,000 | 48.72% |
| Software | 2 | 2,000,000 | 1.15% |
| Internet | 2 | 300,000 | 0.17% |
| Travel | 1 | 160,000 | 0.09% |
| Office Supplies | 1 | 100,000 | 0.06% |
| Transport | 1 | 39,998 | 0.02% |
| **Total** | **39** | **174,172,998** | **100.00%** |

### 3.3 By ledger category / platform counter-leg

| Wallet category | Platform counter-leg | Txns | Amount UGX | % |
|---|---|---:|---:|---:|
| `agent_float_deposit` | `agent_float_deposit` | 11 | 86,720,000 | 49.79% |
| `wallet_deposit` | `general_admin_expense` | 24 | 85,192,998 | 48.91% |
| `wallet_deposit` | `research_development_expense` | 2 | 2,000,000 | 1.15% |
| `wallet_deposit` | `payroll_expense` | 2 | 260,000 | 0.15% |
| | **Total** | **39** | **174,172,998** | **100.00%** |

No transaction in this line carries a `sub_category` value — every leg has `sub_category = NULL`; the sub-classification exists only as free text inside `description`. That is itself a reporting weakness (§8).


### 4. Recipient Breakdown

| Group | Txns | Amount UGX | % of 174,172,998 |
|---|---:|---:|---:|
| MBABAZI ROBERT | 2 | 30,000,000 | 17.22% |
| ALLEN NDYANABO | 1 | 24,500,000 | 14.07% |
| Catherine Nabaggala | 1 | 20,000,000 | 11.48% |
| NAMULINDWA IMMECULATE | 1 | 20,000,000 | 11.48% |
| NAMPIIMA RUTH | 1 | 20,000,000 | 11.48% |
| OKWIR SAMUEL | 1 | 13,000,000 | 7.46% |
| Mudumba samuel | 3 | 7,000,000 | 4.02% |
| WAKABI SIMON PETER | 1 | 6,000,000 | 3.44% |
| KARUNGI ANNET | 1 | 5,000,000 | 2.87% |
| Hilary Evanz | 2 | 3,720,000 | 2.14% |
| Nankambo sharimah | 1 | 3,000,000 | 1.72% |
| victoria nakitto | 1 | 3,000,000 | 1.72% |
| Tugabirwe Apophia | 1 | 3,000,000 | 1.72% |
| elisha maling | 1 | 2,500,000 | 1.44% |
| JOSHUA WANDA | 2 | 2,000,000 | 1.15% |
| TUMUGABIRWE BIBIAN | 1 | 2,000,000 | 1.15% |
| KALULE SHARIF | 1 | 1,500,000 | 0.86% |
| BRENDAN JOSEPH LULE | 1 | 1,500,000 | 0.86% |
| Bisaso Aaron | 1 | 1,000,000 | 0.57% |
| NANGOLI HELLEN | 1 | 1,000,000 | 0.57% |
| Mutebi Daniel | 1 | 1,000,000 | 0.57% |
| Bonny Lutta | 2 | 940,000 | 0.54% |
| NASASIRA FAITH DAVID | 1 | 613,000 | 0.35% |
| NASSANGA WINNIE | 1 | 500,000 | 0.29% |
| LUYIMA SOLOMON SAMUEL | 1 | 420,000 | 0.24% |
| CHELANGAT SARAH | 1 | 200,000 | 0.11% |
| Grace Paul Ochieng | 1 | 160,000 | 0.09% |
| Tumwiine Collines | 1 | 150,000 | 0.09% |
| COLLINES TUMWIINE | 1 | 150,000 | 0.09% |
| LWEGABA ENOCK EUGINE | 1 | 100,000 | 0.06% |
| Watsala Enock | 1 | 90,000 | 0.05% |
| Ssekabembe Kenneth Derrick Dalaa | 1 | 90,000 | 0.05% |
| Muwanguzi Gideon | 1 | 39,998 | 0.02% |
| **Total** | **39** | **174,172,998** | **100.00%** |

### 5. Operator Breakdown

| Group | Txns | Amount UGX | % of 174,172,998 |
|---|---:|---:|---:|
| ATUHAIRE CAROLYNE | 18 | 83,293,000 | 47.82% |
| Bayo Mercy | 11 | 63,339,998 | 36.37% |
| JOSHUA WANDA | 2 | 20,720,000 | 11.90% |
| Nankambo sharimah | 1 | 3,000,000 | 1.72% |
| Benjamin Muhanguzi | 2 | 2,000,000 | 1.15% |
| Kabahuma Lillian | 3 | 1,560,000 | 0.90% |
| RODGERS | 2 | 260,000 | 0.15% |
| **Total** | **39** | **174,172,998** | **100.00%** |

### 6. Wallet Bucket Breakdown

| Group | Txns | Amount UGX | % of 174,172,998 |
|---|---:|---:|---:|
| withdrawable (user-withdrawable) | 28 | 87,452,998 | 50.21% |
| float (company money, never withdrawable) | 11 | 86,720,000 | 49.79% |
| **Total** | **39** | **174,172,998** | **100.00%** |

### 6b. Recipient Role Breakdown

| Group | Txns | Amount UGX | % of 174,172,998 |
|---|---:|---:|---:|
| Agent | 21 | 141,200,000 | 81.07% |
| Supporter | 12 | 27,623,000 | 15.86% |
| Executive (CFO) | 3 | 5,000,000 | 2.87% |
| Employee | 2 | 199,998 | 0.11% |
| Executive (CTO) | 1 | 150,000 | 0.09% |
| **Total** | **39** | **174,172,998** | **100.00%** |

### 7. Business Purpose Breakdown

| Group | Txns | Amount UGX | % of 174,172,998 |
|---|---:|---:|---:|
| Field float / cash-out working capital (funded against approved float requisitions) | 11 | 86,720,000 | 49.79% |
| Operational expense reimbursement — Office Rent | 21 | 84,853,000 | 48.72% |
| Operational expense reimbursement — Software | 2 | 2,000,000 | 1.15% |
| Operational expense reimbursement — Internet | 2 | 300,000 | 0.17% |
| Operational expense reimbursement — Travel | 1 | 160,000 | 0.09% |
| Operational expense reimbursement — Office Supplies | 1 | 100,000 | 0.06% |
| Operational expense reimbursement — Transport | 1 | 39,998 | 0.02% |
| **Total** | **39** | **174,172,998** | **100.00%** |

---

## 8. Misclassification Report

| Finding | Legs | Amount UGX | Severity | Assessment |
|---|---:|---:|---|---|
| **“Office Rent” used as a catch-all.** 21 credits carry `general_admin_expense → office_rent`, but recipients are field agents, partners and staff and the free-text notes read “CREDIT A…”/“newaccount”, not rent. Uganda has no single 84.8M monthly rent obligation split across 21 individual wallets. | 21 | 84,853,000 | 🔴 High | **Misclassified.** This is working-capital / wallet funding, not an occupancy expense. It overstates G&A office rent and understates float/advances in the P&L. |
| **Float funding shown as a “deposit”.** UGX 86.72M of `agent_float_deposit` sits in the report's `deposits_by_source` block, alongside real MTN/Airtel customer deposits. It is an internal treasury movement, not third-party money entering the business. | 11 | 86,720,000 | 🟠 Medium | **Wrong report section.** Belongs in a Treasury / Float Funding block, not Deposits. |
| **Commission credits silently dropped.** 6 `agent_commission_earned` credits posted by the same tool are excluded because the report filters on a 2-category allowlist rather than the tool. | 6 | 1,647,628 | 🟠 Medium | **Under-reporting.** The count 39 is a filtering artefact; the true tool volume is 45 / 175,820,626. |
| **CFO Direct Debits invisible.** Same tool, opposite direction (`system_balance_correction`, `cash_out`). No line exists for them anywhere on the report, so the reader cannot compute net CFO movement. | 4 | 8,945,500 | 🟠 Medium | **Missing line.** Net CFO movement for the day was 165,227,498, not 174,172,998. |
| **`sub_category` never populated.** All 39 legs have `sub_category = NULL`; the sub-classification lives only in prose. Category analytics therefore require string parsing. | 39 | 174,172,998 | 🟡 Low | **Data-quality defect**, not a money defect. |
| **Duplicate-identity double payment.** Two profiles for the same person (Tumwiine Collines `+256786686225` and COLLINES TUMWIINE `+256743586850`) each received 150,000 for the same “Welile School Internet” purpose, 82 minutes apart. | 2 | 300,000 | 🟠 Medium | **Needs business confirmation** — same-purpose, same-amount, two identities. |
| **Repeat same-day pairs.** Bonny Lutta 470,000 twice (11:09 and 16:15) and MBABAZI ROBERT float 20,000,000 then 10,000,000. Distinct references, distinct requisitions — legitimate top-ups or re-posts. | 4 | 30,940,000 | 🟡 Low | **Confirm with the requesters**; no technical duplication (no shared idempotency key). |

### 8.1 Where each category should actually be reported

| Category | Currently under | Should be under | Nature |
|---|---|---|---|
| Agent Float Funding (86,720,000) | Deposits → CFO Direct Credit | **Treasury → Float Funding** | Treasury movement (company money, `float` bucket) |
| “Office Rent” credits (84,853,000) | Deposits → CFO Direct Credit, expensed as office rent | **Treasury → Wallet Funding / Advances**, split into genuine expense vs working capital | Mostly wallet funding, some genuine expense |
| Internet / Software / Transport / Travel / Supplies (2,600,000 in 7 legs) | Deposits → CFO Direct Credit | **Operating Expenses** (correct expense classes) | Genuine business expense reimbursed via wallet |
| Commission credits (1,647,628, excluded) | Nowhere | **Commission Credits** | Earned income to agents |
| CFO Direct Debits (8,945,500, excluded) | Nowhere | **Treasury → CFO Direct Debit (recoveries)** | Recovery of wrongly-credited funds |

Categories in the requested list with **zero** exposure on this line, confirmed by query: Employee Payroll (0 — payroll runs through `hr_pay_disbursements`), Employee Requisitions (0 direct legs; 3 credits merely *reference* a requisition ID in prose), Standing Orders (0), Merchant Float Funding (0), Landlord Funding (0), Salary Payments (0), Treasury Adjustments (0), Error Corrections (0 — the 4 same-day corrections are debits, excluded), Bonuses (0), Recoveries (0 in this line).


---

## 9. Risk Assessment

| # | Risk | Likelihood | Impact | Evidence |
|---|---|---|---|---|
| 1 | **Financial-statement misstatement.** 48.7% of the line is booked as office rent. Any P&L, investor pack or tax filing drawn from `general_admin_expense` for August is materially wrong. | Certain (already happened) | 🔴 High | 21 legs, 84,853,000, all `general_admin_expense`, recipients are field staff |
| 2 | **Executive decisions on an incomplete number.** The report shows gross inflow only; the same tool moved 8.95M the other way, unreported. | Certain | 🟠 Medium | 4 `cash_out` legs, same `source_table` |
| 3 | **Working capital indistinguishable from expense.** Money booked as expense is not tracked as recoverable, so unreturned field float can quietly become a loss. | High | 🔴 High | “Office Rent” credits landed in `withdrawable`, immediately withdrawable, with no advance/float obligation row |
| 4 | **Duplicate-identity payments.** One human with two profiles was paid twice for one purpose; nothing in the tool detects this. | Medium | 🟠 Medium | 2 × 150,000, same purpose, different profile IDs |
| 5 | **Concentration in one operator.** ATUHAIRE CAROLYNE posted 18 legs / 83,293,000 (47.8%) single-handedly, all in a 90-minute burst, all labelled “Office Rent”. | Certain | 🟠 Medium | Operator breakdown §5 |
| 6 | **Role over-grant.** One recipient holds `cfo`,`coo`,`manager`,`operations`,`employee` simultaneously and also received a float credit that day, so approver and beneficiary populations overlap. | Certain | 🟠 Medium | `user_roles` for `Nankambo sharimah` |
| 7 | Ledger integrity / unauthorized posting | None observed | — | 39/39 balanced, 7/7 operators authorized, 0 routing violations |

**Not at risk:** double-entry balance, wallet routing v2, audit trail completeness (45/45 credits have an `audit_logs` row), bucket enforcement (`float` money remained non-withdrawable), and idempotency (no duplicate `idempotency_key`).


---

## 10. Reconciliation Proof

```
Agent Float Funding      11 legs     86,720,000
  "Office Rent" credits   21 legs              0
  Other opex credits       7 legs     87,452,998
                          --------  ------------
REPORTED TOTAL            39 legs    174,172,998   <-- matches report exactly

+ commission credits excluded by filter   6 legs      1,647,628
= true gross CFO Direct Credit          45 legs    175,820,626
- CFO Direct Debits same day             4 legs      8,945,500
= net CFO tool movement 2026-08-03                 166,875,126
```

Bucket cross-check: withdrawable 87,452,998 + float 86,720,000 = **174,172,998** ✅

Recipient cross-check: 33 distinct user IDs, 33 distinct names, summing to **174,172,998** ✅

Operator cross-check: 7 operators, 174,172,998 ✅ (audit-log amount sums agree leg-for-leg)


---

## 11. Appendix A — the 6 credits excluded by the report filter

| Time | Reference | Amount UGX | Recipient | Phone | Bucket | Category | Operator |
|---|---|---:|---|---|---|---|---|
| 08-03 10:11 | `PAY-MSCW4WOE-H8EK` | 40,000 | Sharif Kc | +256757229748 | withdrawable | `agent_commission_earned` | Bayo Mercy |
| 08-03 16:22 | `PAY-MSD9DJES-IB2Z` | 7,628 | MBABAZI ROBERT | +256751237003 | withdrawable | `agent_commission_earned` | Nankambo sharimah |
| 08-03 17:26 | `PAY-MSDBNV7X-UML7` | 150,000 | Mugasha Isaac | +256747452360 | withdrawable | `agent_commission_earned` | Nankambo sharimah |
| 08-03 17:27 | `PAY-MSDBQ6Q0-UL2D` | 420,000 | LUYIMA SOLOMON SAMUEL | +256742412977 | withdrawable | `agent_commission_earned` | Nankambo sharimah |
| 08-03 17:28 | `PAY-MSDBRGD7-IYB1` | 1,000,000 | Mutebi Daniel | +256772833680 | withdrawable | `agent_commission_earned` | Nankambo sharimah |
| 08-03 17:46 | `PAY-MSDCEPY0-0NQ2` | 30,000 | MBABAZI ROBERT | +256751237003 | withdrawable | `agent_commission_earned` | Nankambo sharimah |
| | | **1,647,628** | | | | | |

## 12. Appendix B — the 4 CFO Direct Debits (wallet → platform), excluded from the line

| Time (EAT) | Reference | Amount UGX | Wallet debited | Phone | Bucket | Reason recorded |
|---|---|---:|---|---|---|---|
| 08-03 16:24 | `PAY-MSD9GK2W-DWQ1` | 1,525,500 | MBABAZI ROBERT | +256751237003 | float | “not supposed have” |
| 08-03 17:32 | `PAY-MSDBWGI0-I65S` | 420,000 | LUYIMA SOLOMON SAMUEL | +256742412977 | withdrawable | “NOT SUPPOSED HAVE” |
| 08-03 17:33 | `PAY-MSDBX8XJ-SJIQ` | 1,000,000 | Mutebi Daniel | +256772833680 | withdrawable | “npt vfgjk nj” |
| 08-03 17:45 | `PAY-MSDCDDLO-9QJ1` | 6,000,000 | MBABAZI ROBERT | +256751237003 | float | “not supposed have” |
| | | **8,945,500** | | | | |

Three of the four reverse credits posted earlier the *same day* (LUYIMA 420,000 and Mutebi 1,000,000 are exact reversals of the two commission credits in Appendix A). Two carry non-substantive reason text (“npt vfgjk nj”), which fails the 10-character-meaningful-reason standard in spirit even though it passes in length.


---

## 13. Read-only declaration

This was a **strictly read-only investigation**. No wallets, ledger entries, balances, wallet projections, reports, report rows, classifications, edge functions, RPCs, triggers, migrations or business records were created, altered or deleted. No corrective posting was made. Every number above is reproducible with `SELECT` statements against the stated tables for the window `2026-08-02T21:00:00Z` → `2026-08-03T21:00:00Z`.

