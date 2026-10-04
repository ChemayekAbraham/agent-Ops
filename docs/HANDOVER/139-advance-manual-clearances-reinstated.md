# 139 — Manual advance "payments" were not payments: all 12 added back (UGX 6,785,997.18)

**Date:** 2026-09-26, completed 2026-09-27 · **Asked by:** Josh ("reapply these onto the agents"); the CFO asked for the rest on 09-27
**Applied:** live, by direct SQL through `query_database` (data correction only; no schema change, no migration)
**Related:** note 137 on `claude/agent-advance-repayments-storage-kt6tr9` (the 12 manual entries, 20 Aug – 21 Sep), note 115 (Fred Muwanguzi's double deduction), and the accountability record `docs/2026-09-25-advance-balance-corrections-accountability-record.md` (section 5A).

## What changed in our understanding

Note 137 treated the 12 `cfo_advance_payment_recorded` entries (UGX 6,785,997.18) as **real receipts that were never booked**. On 2026-09-26 Josh confirmed that **none of them was a real payment**. No money came from the agents; the entries only reduced the advance balances.

So the follow-up in note 137 ("book the 12 receipts in `general_ledger`") is **wrong and must not be done**. Booking them would create cash that never arrived.

## What was done

Josh decided, advance by advance, which cleared amounts go back on the agent as debt.

**Added back (UGX 3,513,872):**

| Entries (note 137) | Advance | Amount | Balance before → after | Status | `agent_advance_ledger` | `audit_logs` |
|---|---|---|---|---|---|---|
| 11 | Ian Muhwezi, 2nd, `ba37593d-8b29-482b-b305-f98210864616` | 1,500,000 | 3,128,974.66 → 4,628,974.66 | active | `13475e93-c2fd-4b94-9253-c708c70fbcf7` | `fc5d6156-2650-44a1-99a3-9b38b39c528a` |
| 10 | same advance | 500,000 | 4,628,974.66 → 5,128,974.66 | active | `f6f8b8f0-44b0-4e7c-815c-7978491779ce` | `61bbe05d-11b1-4b9b-afc0-54f36a90f272` |
| 2, 4, 5 | Sharifu Kalule, `cef95679-bd3b-4b4a-88a0-bae32e39a1c5` | 1,013,872 | 0 → 1,013,872 | completed → **overdue** | `bb40caf1-5c7f-4cf1-8c68-ad599bf91a44` | `e9ae57c9-8c4f-4f72-ac85-99cacc501520` |
| 3 | Oacar Arnold, `978a9e12-9764-4b9d-b854-28c1ac47c4cd` | 500,000 | 1,175,013.88 → 1,675,013.88 | overdue | `56ce42f7-e565-4427-867a-f5e00f9897ee` | `f345be1f-0d33-47e5-962b-5accf49e2326` |

**Added back on 2026-09-27, at the CFO's request (UGX 3,272,125.18).** These were first left cleared on 09-26 because the advances were completed. The CFO challenged this, because the money would otherwise be unrecoverable, and Josh agreed.

| Entries | Advance | Amount | Balance | Status | `agent_advance_ledger` | `audit_logs` |
|---|---|---|---|---|---|---|
| 1, 6, 7, 8 | Ian Muhwezi, 1st, `5a1a60b0-1f00-44e0-b953-f4f442fab2cd` | 2,570,689.18 | 0 → 2,570,689.18 | completed → overdue | `62061d94-e884-4c54-ad7a-60084286e6b7` | `59d88c01-f5bb-495e-8f87-4b53a3df6cec` |
| 9 | Okwakol Micheal, `8977ca67-a3f4-41cd-ae32-df3999290b25` | 214,433 | 0 → 214,433 | completed → overdue | `b61dce93-dce2-4c3a-a8c8-7b9088b057e0` | `e749214c-7cdb-48af-b4b2-b4bfc52b2636` |
| 12 | Fred Muwanguzi, `19c74e2a-4112-41fd-ac7a-d13956cb9695` | 487,003 | 0 → 487,003 | completed → overdue | `4893f176-ed1b-4363-b0af-2d04337494b3` | `5ce87ae2-4220-4a80-a451-93c769575b0e` |

- **Fred's 700k advance did not pay entry 12.** On 09-23, eight minutes after the 700k was credited, error correction ECW-E53519D256 moved 485,452 from his wallet as "Repayment of Advance". That repaid the half of his 974,006 that was still showing, not the 487,003 that entry 12 had already cleared. Because the two amounts are close, they are easy to mistake for the same money.
- **Okwakol:** the deduction job taking nothing for about 4 weeks is not a payment.

**Total: 7 `advance_balance_reinstated` audit rows, summing to exactly 6,785,997.18. Nothing is written off.**

## How it was done, and why

- **One transaction per batch, with a balance check.** Each update ran only if the balance still matched the one just read, so no deduction that ran in between could be overwritten.
- **Nothing in the wallets or `general_ledger` changed.** The original clearances never reached the general ledger (the old `cfo-record-advance-payment` wallet debit failed silently; see migration `20260925200000`), so there was nothing to reverse there.
- **The ledger rows record `amount_deducted = 0`, not a negative amount.** `zz_guard_agent_advance_double_charge` caps each day's charges using `SUM(amount_deducted)` for that advance and date. A −1.5M row would lower that sum, and the deduction job could then take an extra 1.5M from the wallet the same day. The reinstatement shows only in `opening_balance → closing_balance`, with `recovery_source = 'manual_reversal'` and `deduction_status = 'none'`. The status check has no reversal value.
- **The four completed advances (Sharifu, Ian's 1st, Okwakol, Fred) were reopened as `overdue`, with `arrears_balance` at 0.** All had expired. With arrears at 0, the job collects only each advance's daily installment, not the whole reinstated amount at once. Sharifu (`b94abec1`), Ian (`ba37593d`) and Fred (`1ad14342`, the 700k from 09-23) each also have another open advance, so they now repay two at the same time.
- **The audit rows** use `action_type = 'advance_balance_reinstated'` and are attributed to Josh's own account, `cb798acb-68bc-4b4e-a414-a3d374e030b6`.
- **No agent notifications were sent.** `notify_agent_advance_deducted` fires only when `amount_deducted > 0`. Josh will explain the changes to the agents himself.

## Still open

1. **Note 137's "book the receipts" follow-up must be struck** when that branch merges.
2. **Past reports.** Any collection or repayment report generated before 2026-09-26 counts all 12 entries (UGX 6,785,997.18) as repayments.

## Don't

- Don't book any of the 12 entries as receipts.
- Don't re-run `cfo_record_advance_payment` or `cancel_agent_advance` on these advances to "tidy up".
- Don't write negative `amount_deducted` rows to adjust a balance (see the double-charge guard above).

## Verify

```sql
select id, status, outstanding_balance, arrears_balance
from agent_advances
where id in ('ba37593d-8b29-482b-b305-f98210864616','cef95679-bd3b-4b4a-88a0-bae32e39a1c5','978a9e12-9764-4b9d-b854-28c1ac47c4cd',
             '5a1a60b0-1f00-44e0-b953-f4f442fab2cd','8977ca67-a3f4-41cd-ae32-df3999290b25','19c74e2a-4112-41fd-ac7a-d13956cb9695');

-- expect 7 rows summing to 6,785,997.18
select count(*), sum((metadata->>'amount')::numeric) from audit_logs where action_type = 'advance_balance_reinstated';

select id, record_id, created_at, new_values
from audit_logs
where action_type = 'advance_balance_reinstated'
order by created_at;
```
