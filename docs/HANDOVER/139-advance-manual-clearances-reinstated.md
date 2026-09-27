# 139 — Manual advance "payments" were not payments: four balances added back, three left as write-offs

**Date:** 2026-09-26 · **Asked by:** Josh ("reapply these onto the agents")
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

**Left as they are (UGX 3,272,125.18).** These advances are completed and stay closed:
- Ian Muhwezi, 1st advance `5a1a60b0`: entries 1, 6, 7, 8, total 2,570,689.18
- Okwakol Micheal, `8977ca67`: entry 9, 214,433
- Fred Muwanguzi, `19c74e2a`: entry 12, 487,003

## How it was done, and why

- **One transaction per batch, with a balance check.** Each update ran only if the balance still matched the one just read, so no deduction that ran in between could be overwritten.
- **Nothing in the wallets or `general_ledger` changed.** The original clearances never reached the general ledger (the old `cfo-record-advance-payment` wallet debit failed silently; see migration `20260925200000`), so there was nothing to reverse there.
- **The ledger rows record `amount_deducted = 0`, not a negative amount.** `zz_guard_agent_advance_double_charge` caps each day's charges using `SUM(amount_deducted)` for that advance and date. A −1.5M row would lower that sum, and the deduction job could then take an extra 1.5M from the wallet the same day. The reinstatement shows only in `opening_balance → closing_balance`, with `recovery_source = 'manual_reversal'` and `deduction_status = 'none'`. The status check has no reversal value.
- **Sharifu's advance was reopened as `overdue`, with `arrears_balance` left at 0.** It had expired on 2026-09-13. With arrears at 0, the job collects only the 34,800 daily installment, not the whole 1,013,872 at once. He also has a separate open advance, `b94abec1` (2,962,157.04 outstanding).
- **The audit rows** use `action_type = 'advance_balance_reinstated'` and are attributed to Josh's own account, `cb798acb-68bc-4b4e-a414-a3d374e030b6`.
- **No agent notifications were sent.** `notify_agent_advance_deducted` fires only when `amount_deducted > 0`. Josh will explain the changes to the agents himself.

## Still open

1. **The write-off.** The CFO should decide how to account for the UGX 3,272,125.18 left as it is. It is a reduction of advance receivable with no cash received, which is a write-off. First check whether the general ledger's advance receivable still carries these amounts; if it does, it disagrees with `agent_advances`.
2. **Note 137's "book the receipts" follow-up must be struck** when that branch merges.
3. **Past reports.** Any collection or repayment report generated before 2026-09-26 counts all 12 entries (UGX 6,785,997.18) as repayments.

## Don't

- Don't book any of the 12 entries as receipts.
- Don't re-run `cfo_record_advance_payment` or `cancel_agent_advance` on these advances to "tidy up".
- Don't write negative `amount_deducted` rows to adjust a balance (see the double-charge guard above).

## Verify

```sql
select id, status, outstanding_balance, arrears_balance
from agent_advances
where id in ('ba37593d-8b29-482b-b305-f98210864616','cef95679-bd3b-4b4a-88a0-bae32e39a1c5','978a9e12-9764-4b9d-b854-28c1ac47c4cd');

select id, record_id, created_at, new_values
from audit_logs
where action_type = 'advance_balance_reinstated'
order by created_at;
```
