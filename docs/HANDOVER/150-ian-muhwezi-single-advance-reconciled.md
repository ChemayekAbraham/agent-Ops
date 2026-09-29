# 150 — Ian Muhwezi: the 7 Sep advance is his only advance (CFO decision 28 Sep)

**Status: LIVE 2026-09-29.** Instructed by Joshua Wanda (CFO role) and carried out by Claude against production.

**Agent:** Ian Muhwezi, +256787725122, `3d78f1f8-f690-4fe8-bb2e-202f3ef2ecb0`

## Why

The handover-139 reinstatement (27 Sep) reopened his 10 Aug advance (`5a1a60b0`) at 2,570,689.18, next to his 7 Sep advance (`ba37593d`). The agent dashboard and every advance SMS add up all `active` and `overdue` advances, so he was being shown about 7.4M owed. The CFO decided his only advance is the 7 Sep one, at **UGX 4,981,631.08**, its balance at the start of 28 Sep.

## What was done

| # | Change | Result | Audit |
|---|---|---|---|
| 1 | `cancel_agent_advance('5a1a60b0…', p_recoup => false, …)` called as Joshua (`cb798acb…`) at 07:45 UTC | 10 Aug advance: `cancelled / write_off`, outstanding, arrears and instalment set to 0, `pre_cancel_outstanding` = 2,480,556.18 | `audit_logs.agent_advance_cancelled` |
| 2 | Deductions he paid toward the 10 Aug advance after it was reopened (128,667 on 28 Sep + 3,060 on 29 Sep = **131,727**) credited to the 7 Sep advance | 7 Sep advance: 4,926,378.08 → **4,794,651.08**; arrears 2,103,052.08 → 1,971,325.08 | `agent_advance_ledger` `491ce0b7…` (`recovery_source = 'cfo_credit_transfer'`, `amount_deducted = 0`); `audit_logs` `3e6c0f76…` (`agent_advance_credit_transferred`) |
| 3 | Dashboard: `AgentMyAdvancesCard` now leaves out `cancelled` advances | Without this, the cancelled advance appeared with the **Active** badge and a 0 balance, because `STATUS_META` has no `cancelled` entry | code |
| 4 | Correction SMS sent through `sms-test-send` (Africa's Talking, statusCode 100, `ATXid_2487c99d…`) | "…UGX 4,981,631 less UGX 186,980 recovered since 28 Sep = balance UGX 4,794,651…" | `net._http_response` 144565 |

**How it reconciles:** 4,981,631.08 − 55,253 (paid to the 7 Sep advance on 28 Sep) − 131,727 (transferred) = 4,794,651.08.

## Follow-up the same day: the advance statement now matches the wallet statement

The row in step 2 showed `+UGX 0 / −UGX 0` with the balance dropping by 131,727, and nothing on the statement explained it (Josh flagged it from a screenshot). The fix, in one transaction:

- The **13** `agent_advance_ledger` deduction rows from 28–29 Sep (131,727; each already one-to-one with an `agent_repayment` wallet debit by time and amount) were moved from `5a1a60b0` to `ba37593d`.
- Transfer row `491ce0b7` was deleted.
- `opening_balance`/`closing_balance` were recalculated from 28 Sep on both advances. The 7 Sep advance runs 4,981,631.08 → **4,794,651.08** (equal to `outstanding_balance`). The 10 Aug advance now shows only its penalty, 2,570,689.18 → 2,612,283.18, and `pre_cancel_outstanding` was set to that figure.
- Audit entry: `agent_advance_deductions_reattributed`.

The 7 Sep statement now has 16 deduction lines totalling 186,980, one for each wallet debit. The `general_ledger` legs still carry `source_id = 5a1a60b0` (ledger rows aren't rewritten), so A10 per advance still differs from the statement by that 131,727.

## Follow-up 2: the whole 7 Sep statement cleaned (29 Sep)

Josh asked for every row to match a wallet deduction. Four rows had no wallet debit behind them and were deleted. Their full JSON is saved in `audit_logs.agent_advance_statement_cleaned`.

| Row | What it was |
|---|---|
| `5f912631` 14 Sep | 500,000 "deduction", a fake clearance with no wallet debit |
| `f6f8b8f0` 26 Sep | +0/−0 reinstatement of that 500,000 |
| `13475e93` 26 Sep | +0/−0 reinstatement of the 1,500,000 clearance (handover-139 entry 11). The clearance itself never wrote a row; the balance just dropped on 21 Sep |
| `3f69351b` 23 Sep | 1 UGX deducted on the statement only, never taken from the wallet |

The running balances were recalculated from **7,700,000** (principal 6,000,000 + access fee 1,680,000 + 20,000 fixed fee). The statement now has **71 deduction rows = 71 wallet debits = 2,906,327.92**, and it runs continuously to **4,793,672.08**. Taking out the unpaid shilling raised the balance and arrears by 1 UGX.

## What was not done, and why

- **No `general_ledger` write-off.** The 22 Sep receivables restatement set the 10 Aug advance's A10 to its balance at that time, which was 0 because of the fake clearance. The 1.71M moved to equity E3. The 27 Sep reinstatement only changed `agent_advance_ledger`. So the ledger holds no receivable for this advance. A DR X4 / CR A10 posting would take A10 about −2.6M and count the loss twice.
- **The transfer has no wallet or ledger leg.** The 131,727 already went out of his wallet and was posted CR A10 (`agent_advance_repayment`, source 10 Aug advance). Re-recording it as a deduction would have taken it from his wallet a second time. The adjustment row uses `amount_deducted = 0`, so the double-charge guard and the deduction notification ignore it (the handover-139 pattern).
- Cancelling stops deductions, reminders and the penalty for that advance. `process-agent-advance-deductions`, `send-advance-payment-reminder` and `notify-advance-deduction` only select `active`/`overdue`.

## Still open

- **The 7 Sep advance's A10 is also understated.** Handover-139 entry 11 reinstated 1.5M on this advance operationally, with no ledger leg. This affects all 12 handover-139 reinstatements. Work out A10 per advance from `general_ledger` using `ledger_account_map`. `sofp_ledger_legs(now())` times out on `query_database`.
- **The 41,594 penalty on the 10 Aug advance (28 and 29 Sep) is still posted** as `interest_expense` / `agent_advance_credit`. That's the known wrong-sign penalty problem, left as it is.
- **Arrears on the 7 Sep advance (1,971,325) are still due on the original schedule**, with the term ending 7 Oct. The CFO hasn't chosen option B (reset the terms).

## Verify

```sql
select id, status, outstanding_balance, arrears_balance, cancellation_mode, pre_cancel_outstanding
from agent_advances where agent_id = '3d78f1f8-f690-4fe8-bb2e-202f3ef2ecb0' and status in ('active','overdue','cancelled');
-- expect: 5a1a60b0 cancelled/write_off/0; ba37593d active, 4,794,651.08 less any later deductions
select count(*) from agent_advance_ledger
where advance_id = '5a1a60b0-1f00-44e0-b953-f4f442fab2cd' and created_at > '2026-09-29 07:45:09+00';
-- expect 0
```
