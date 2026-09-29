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
