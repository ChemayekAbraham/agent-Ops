---
name: Advance repayment frequency is authoritative
description: Weekly/bi-weekly/monthly agent advances are collected only on their due day; installments and arrears are per-installment, never per-day
type: feature
---
`agent_advances.repayment_frequency` (daily | weekly | biweekly | monthly) is the sole
schedule authority for agent advances. Non-daily advances must NEVER be broken into
daily deductions.

Canonical helpers (2026-08-01):
- `advance_period_days(frequency)` → 1 / 7 / 14 / 30
- `advance_installment_amount(principal, access_fee, cycle_days, frequency, installment_amount)`
  → `installment_amount` when set, else ceil(total_payable / ceil(cycle_days/period_days))
- `advance_expected_repaid_to_date(issued_at, principal, access_fee, cycle_days, frequency, installment_amount)`
  → installment × whole periods elapsed (capped at total payable) — measured in
  installments, never days.

Collection paths (both frequency-aware):
- `sweep_agent_advance_recovery()` (daily cron, `0 4 * * *` — rescheduled from `*/15 * * * *` in
  `20260629101626_...sql:173-186`; see `mem/features/wallet/auto-advance-recovery-sweep.md`): on
  non-due days it writes an `agent_advance_ledger` row with `deduction_status='not_due'` and takes
  nothing.
  Due-day anchor = last ledger date with `amount_deducted > 0`, falling back to the
  issue date (self-correcting after missed runs / term edits).
- `process-agent-advance-deductions` edge fn: same due-day gate + period installment.

Arrears: grow/shrink by (scheduled installment − collected) on DUE days only, capped to
outstanding by `tg_cap_advance_arrears`. Never accrue arrears on a not-due day.
`get_agent_advance_repayment_monitor.scheduled_daily` now returns the period
installment (UI label: "Installment due").
