# 137: Manual agent advance corrections, 20 Aug – 21 Sep 2026 (balances reduced, receipts never booked)

**Record only, nothing corrected yet. Read this before trusting `agent_advances.outstanding_balance`
on the six advances below, before reconciling A10 (agent advance receivables) against cash, and
before running `cfo-record-advance-payment` against any of these advances.**

Read from production on 2026-09-25.

## What happened

Between 20 Aug and 21 Sep 2026, Josh Wanda recorded 12 manual advance payments through
`cfo-record-advance-payment`. He did this while working in a browser session signed in to **Benjamin
Muhanguzi's account** (`cf561688-b3a2-4f62-b9c1-67ee7b36ff2b`). The purpose was to correct advance
balances on days when the automatic deduction job (`process-agent-advance-deductions`) had not
deducted.

Every entry is therefore attributed to Benjamin's account in `audit_logs`
(`action_type = 'cfo_advance_payment_recorded'`), not to Josh. Josh has put his statement taking
responsibility on the branch `claude/agent-advance-repayments-storage-kt6tr9`, in
`docs/2026-09-25-advance-balance-corrections-accountability-record.md`. It is deliberately not merged
into `lovable`.

| # | Time (UTC) | Agent | Advance | Amount (UGX) | Method | Balance before → after |
|---|---|---|---|---|---|---|
| 1 | 08-20 07:57 | Ian Muhwezi | `5a1a60b0-1f00-44e0-b953-f4f442fab2cd` | 2,000,000 | mobile money | 3,059,843.18 → 1,059,843.18 |
| 2 | 08-24 12:37 | Sharifu Kalule | `cef95679-bd3b-4b4a-88a0-bae32e39a1c5` | 506,936 | mobile money | 1,013,872 → 506,936 |
| 3 | 08-26 12:20 | Oacar Arnold | `978a9e12-9764-4b9d-b854-28c1ac47c4cd` | 500,000 | mobile money | 2,370,736.88 → 1,870,736.88 |
| 4 | 08-27 11:05 | Sharifu Kalule | `cef95679-…` | 253,468 | mobile money | 506,936 → 253,468 |
| 5 | 09-01 08:20 | Sharifu Kalule | `cef95679-…` | 253,468 | mobile money | 253,468 → 0 |
| 6 | 09-05 13:07 | Ian Muhwezi | `5a1a60b0-…` | 285,575 | mobile money | 571,149.18 → 285,574.18 |
| 7 | 09-07 05:32 | Ian Muhwezi | `5a1a60b0-…` | 142,557 | mobile money | 285,114.18 → 142,557.18 |
| 8 | 09-07 07:13 | Ian Muhwezi | `5a1a60b0-…` | 142,557.18 | mobile money | 142,557.18 → 0 |
| 9 | 09-09 10:58 | Okwakol Micheal | `8977ca67-a3f4-41cd-ae32-df3999290b25` | 214,433 | mobile money | 214,433 → 0 |
| 10 | 09-14 14:03 | Ian Muhwezi | `ba37593d-8b29-482b-b305-f98210864616` | 500,000 | mobile money | 6,211,972 → 5,711,972 |
| 11 | 09-20 13:06 | Ian Muhwezi | `ba37593d-…` | 1,500,000 | cash | 4,698,152.54 → 3,198,152.54 |
| 12 | 09-21 11:24 | Fred Muwanguzi | `19c74e2a-4112-41fd-ac7a-d13956cb9695` | 487,003 | mobile money | 974,006.42 → 487,003.42 |
| | | | | **6,785,997.18** | | |

No entry carries a payment reference, and every `reason` reads `manual payment`.

Before 9 of the 12 entries, the deduction job had recorded missed days (`deduction_status = 'none'`)
in the previous seven days. Okwakol Micheal (#9) had no successful deduction for 29 days. Entries 1,
4 and 5 had no missed days in the prior week, and the data does not show why they were made.

## What is wrong with them

1. **None of the 12 has a `general_ledger` posting.** The old `cfo-record-advance-payment` posted a
   wallet cash-out leg for every payment method. `create_ledger_transaction` refused it for
   insufficient balance, and the function swallowed the error. The advance balance still went down and
   the audit row was still written. UGX 6,785,997.18 of receipts is unbooked. This is the "thirteen
   entries / UGX 6,785,998.18 across six advances" described in migration
   `20260925200000_cfo_record_advance_payment_atomic.sql`. The thirteenth entry and the one-shilling
   difference have not been identified.
2. **Four entries also have no `agent_advance_ledger` row:** #1, #2, #8 and #11.
3. **#12 is on the same advance as doc 115.** That doc covers Fred Muwanguzi's 23 Sep double deduction
   and the closure of `19c74e2a`, but not this 21 Sep payment. Read both together.

Migration `20260925200000` makes future recordings atomic and adds the external-receipt categories
(`agent_advance_repayment_external` → A10, `agent_advance_receipt_bank` → A1). It states explicitly
that it does not touch historical rows. These 12 are still open.

## Current state of the six advances (2026-09-25)

| Advance | Agent | Status | Outstanding (UGX) |
|---|---|---|---|
| `5a1a60b0` | Ian Muhwezi | completed | 0 |
| `cef95679` | Sharifu Kalule | completed | 0 |
| `978a9e12` | Oacar Arnold | overdue | 1,175,013.88 |
| `8977ca67` | Okwakol Micheal | completed | 0 |
| `ba37593d` | Ian Muhwezi | active | 3,180,174.66 |
| `19c74e2a` | Fred Muwanguzi | completed | 0 |

## What still needs doing

- Book the 12 receipts in `general_ledger` with the external-receipt categories from `20260925200000`
  (debit A1 cash, or A5 if not yet banked, and credit A10). Use one approved, balanced correction per
  entry, with an idempotency key and `source_table = 'agent_advances'`. It needs CFO approval.
- Decide whether to backfill the four missing `agent_advance_ledger` rows. They are history only; the
  balances on `agent_advances` already reflect the payments.

## What not to do

- **Don't re-run `cfo-record-advance-payment` for any of these 12.** The balance was already reduced;
  running it again would reduce it a second time.
- Don't treat the missing ledger postings as missing payments. The balance reductions are real
  decisions and are on record in `audit_logs`; only the receipt side is missing.
- Don't attribute these entries to Benjamin Muhanguzi on the strength of `audit_logs.user_id`.
  Read the statement referenced above.

## Verify this is still the state

```sql
-- the 12 audit rows
select created_at, record_id as advance_id, metadata->>'amount' as amount,
       metadata->>'payment_method' as method, metadata->>'opening_balance' as opening
from audit_logs
where user_id = 'cf561688-b3a2-4f62-b9c1-67ee7b36ff2b'
  and action_type = 'cfo_advance_payment_recorded'
order by created_at;

-- still unbooked: expect 0 rows for each audit row's advance within ±2 minutes
select a.created_at, a.record_id,
       (select count(*) from general_ledger g
         where g.source_id::text = a.record_id
           and g.created_at between a.created_at - interval '2 min'
                                and a.created_at + interval '2 min') as gl_rows
from audit_logs a
where a.user_id = 'cf561688-b3a2-4f62-b9c1-67ee7b36ff2b'
  and a.action_type = 'cfo_advance_payment_recorded'
order by a.created_at;
```
