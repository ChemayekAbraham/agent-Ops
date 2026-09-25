# Accountability record: manual agent advance balance corrections, 20 Aug – 21 Sep 2026

**Recorded:** 25 September 2026
**Person taking responsibility:** Joshua Wanda
**Account used:** Benjamin Muhanguzi, profile `cf561688-b3a2-4f62-b9c1-67ee7b36ff2b` (phone +256783673998)

---

## 1. Statement

I, Joshua Wanda, state the following.

1. I made the twelve manual advance payment entries listed in section 2.
2. I made them while working in a browser session that was signed in to Benjamin Muhanguzi's account. That session was open to me during this period. The system therefore records these entries under his account, not mine.
3. I made these entries to correct agent advance balances on days when the automatic advance deduction job did not deduct as it should have.
4. I take full responsibility for these entries and their effect on the advance balances. Benjamin Muhanguzi should not be held responsible for them because his account appears in the audit trail.

Signed: ______________________ (Joshua Wanda)   Date: ______________

---

## 2. The entries

The data below was read from the production database on 25 September 2026. Every entry is an `audit_logs` row with `action_type = 'cfo_advance_payment_recorded'` and `user_id = cf561688-b3a2-4f62-b9c1-67ee7b36ff2b`, written by the `cfo-record-advance-payment` edge function.

| # | Time (UTC) | Agent | Advance ID | Amount (UGX) | Method | Balance before → after (UGX) |
|---|---|---|---|---|---|---|
| 1 | 2026-08-20 07:57 | Ian Muhwezi | `5a1a60b0-1f00-44e0-b953-f4f442fab2cd` | 2,000,000 | mobile money | 3,059,843.18 → 1,059,843.18 |
| 2 | 2026-08-24 12:37 | Sharifu Kalule | `cef95679-bd3b-4b4a-88a0-bae32e39a1c5` | 506,936 | mobile money | 1,013,872 → 506,936 |
| 3 | 2026-08-26 12:20 | Oacar Arnold | `978a9e12-9764-4b9d-b854-28c1ac47c4cd` | 500,000 | mobile money | 2,370,736.88 → 1,870,736.88 |
| 4 | 2026-08-27 11:05 | Sharifu Kalule | `cef95679-bd3b-4b4a-88a0-bae32e39a1c5` | 253,468 | mobile money | 506,936 → 253,468 |
| 5 | 2026-09-01 08:20 | Sharifu Kalule | `cef95679-bd3b-4b4a-88a0-bae32e39a1c5` | 253,468 | mobile money | 253,468 → 0 |
| 6 | 2026-09-05 13:07 | Ian Muhwezi | `5a1a60b0-1f00-44e0-b953-f4f442fab2cd` | 285,575 | mobile money | 571,149.18 → 285,574.18 |
| 7 | 2026-09-07 05:32 | Ian Muhwezi | `5a1a60b0-1f00-44e0-b953-f4f442fab2cd` | 142,557 | mobile money | 285,114.18 → 142,557.18 |
| 8 | 2026-09-07 07:13 | Ian Muhwezi | `5a1a60b0-1f00-44e0-b953-f4f442fab2cd` | 142,557.18 | mobile money | 142,557.18 → 0 |
| 9 | 2026-09-09 10:58 | Okwakol Micheal | `8977ca67-a3f4-41cd-ae32-df3999290b25` | 214,433 | mobile money | 214,433 → 0 |
| 10 | 2026-09-14 14:03 | Ian Muhwezi | `ba37593d-8b29-482b-b305-f98210864616` | 500,000 | mobile money | 6,211,972 → 5,711,972 |
| 11 | 2026-09-20 13:06 | Ian Muhwezi | `ba37593d-8b29-482b-b305-f98210864616` | 1,500,000 | cash | 4,698,152.54 → 3,198,152.54 |
| 12 | 2026-09-21 11:24 | Fred Muwanguzi | `19c74e2a-4112-41fd-ac7a-d13956cb9695` | 487,003 | mobile money | 974,006.42 → 487,003.42 |
| | | | | **6,785,997.18** | | |

Six advances are affected. None of the twelve entries has a payment reference, and every entry's reason reads `manual payment`.

## 3. Did the deduction job miss days first?

For each entry, I counted `agent_advance_ledger` rows on that advance in the seven days before it. A row with `deduction_status = 'none'` is a day the job ran but deducted nothing.

| # | Agent | Missed days in prior 7 days | Last automatic deduction before the entry |
|---|---|---|---|
| 1 | Ian Muhwezi | 0 | 2026-08-19 |
| 2 | Sharifu Kalule | 2 | 2026-08-23 |
| 3 | Oacar Arnold | 6 | 2026-08-25 |
| 4 | Sharifu Kalule | 0 | 2026-08-23 |
| 5 | Sharifu Kalule | 0 | 2026-08-23 |
| 6 | Ian Muhwezi | 3 | 2026-09-05 |
| 7 | Ian Muhwezi | 4 | 2026-09-07 |
| 8 | Ian Muhwezi | 4 | 2026-09-07 |
| 9 | Okwakol Micheal | 28 (every row) | 2026-08-11, 29 days earlier |
| 10 | Ian Muhwezi | 6 | 2026-09-14 |
| 11 | Ian Muhwezi | 3 | 2026-09-20 |
| 12 | Fred Muwanguzi | 6 | 2026-09-20 |

Nine of the twelve entries follow days with missed deductions. Entry 9 is the clearest case: the job deducted nothing for Okwakol Micheal for about four weeks.

Entries 1, 4 and 5 show no missed days in the prior week. The database does not show why they were made. They may be payments the agents made directly, outside the wallet, which the job never sees.

## 4. What the records prove and what they do not

**The records prove:**
- the account that made each entry;
- the time, advance, amount, payment method and balance change of each entry;
- how the automatic deduction history looked beforehand.

**The records do not prove who was at the keyboard.** Every entry is attributed to Benjamin Muhanguzi's account. Section 1 is the only record that the person was Joshua Wanda. It is a statement, not something the database can confirm.

This record does not change or remove any row. The audit trail still shows Benjamin Muhanguzi's account, and this document explains that attribution rather than replacing it.

## 5. Known defects in these entries (still open)

These entries were affected by a defect in the old `cfo-record-advance-payment` function. They are the failed postings described in `supabase/migrations/20260925200000_cfo_record_advance_payment_atomic.sql`.

1. **No money entries in `general_ledger` for any of the twelve.** The old function tried to post a wallet debit against each agent's withdrawable balance. That posting was refused for insufficient balance, and the function ignored the error. The advance balances went down, but the receipts were never booked. Total unbooked: UGX 6,785,997.18. The migration counts thirteen entries totalling UGX 6,785,998.18; the thirteenth entry and the one-shilling difference are not identified here.
2. **Four entries have no `agent_advance_ledger` row:** entries 1, 2, 8 and 11.
3. **Fix status:** the migration makes future recordings all-or-nothing and adds the categories for booking external receipts. It does not touch past rows. Booking these twelve receipts needs a separate, approved correction.

## 6. Follow-up

- The receipts in section 2 should be booked in `general_ledger` using the external-receipt categories, through an approved correction.
