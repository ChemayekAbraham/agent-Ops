---
name: Advance double-charge guard
description: DB trigger blocks any second charge of the same agent advance installment (stale-balance race between daily cron and 15-min sweep)
type: constraint
---
Trigger `zz_guard_agent_advance_double_charge` (BEFORE INSERT on `agent_advance_ledger`) locks the advance `FOR UPDATE` and rejects a charging row when:
- `opening_balance > agent_advances.outstanding_balance + 1` → `ADVANCE_LEDGER_STALE_OPENING` (the row was computed before another recovery path committed)
- `amount_deducted` exceeds outstanding + interest → `ADVANCE_LEDGER_OVER_COLLECTION`
- same-day total would exceed `installment + arrears` → `ADVANCE_PERIOD_CAP_EXCEEDED`

**Why:** the daily cron (`process-agent-advance-deductions`) read `agent_advance_ledger` while `sweep_agent_advance_recovery`'s transaction was still uncommitted, so both charged the same installment and debited the wallet twice (incident ADV-DUP-2026-08-01: Senkungu Asaph 8,160 / Mukama Dan 6,400 / yaseen kc 12,900 / Bluestaff kenny 999 — all refunded).

**How to apply:** every recovery path MUST insert the `agent_advance_ledger` row FIRST, check the error, and abort before debiting the wallet. Never ignore that insert's error. Do not add a unique index per (advance, date) — legitimate partial trickle recoveries happen many times a day.
