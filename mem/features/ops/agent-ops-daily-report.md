---
name: Agent Ops Daily Report (merged)
description: Single 18:30 EAT email combining agent field activity + the credit-advance brief; the separate agent-advances-daily-report was merged in and deleted
type: feature
---
Edge function `agent-ops-daily-report` is the ONLY scheduled Agent Ops email. The former
`agent-advances-daily-report` function and its cron (`agent-advances-daily-report-1800-eat`,
jobid 6410) were merged into it and removed on 2026-07-28. Do not recreate a second one.

- **Recipients:** benjamin@welile.com, paphra.me@gmail.com.
- **Schedule:** pg_cron `agent-ops-daily-report-1800-eat` at `30 15 * * *` (18:30 EAT) —
  deliberately AFTER `daily-advance-deductions` (14:50 UTC) so "repaid today" is complete.
- **Sections (fixed order):** 1 Field activity today · 2 Advance programme summary ·
  3 Repayment trend · 4 Arrears and advance demand · 5 Receivables — projected principal
  and interest (the interest projection MUST stay last; it used to be duplicated at the top).
- **Gotchas that caused wrong numbers before:**
  - `profiles` has `full_name`, `phone`, `email` — there is NO `phone_number`. Selecting it
    errored the whole query and rendered every row as "Unknown agent". Name fallback chain:
    full_name → phone → email → `Agent <id8>`.
  - PostgREST caps plain selects at 1000 rows. All bulk reads go through the `fetchAll`
    paginator; without it `agent_advance_ledger` truncation made "repaid today" show 0.
  - `agent_advances.arrears_balance` is only rewritten by the nightly deduction job, so the
    report nets it against today's `agent_advance_ledger` payments per advance and shows a
    "Paid today" column plus "Arrears cleared today".
- **Charts:** QuickChart (Chart.js v2 syntax — use `horizontalBar` and `lineTension`, and
  supply both v2 `xAxes/yAxes` and v3 `x/y` scale keys for stacked bars).
- **Idempotency:** one `system_events` row (`event_type='agent_ops_daily_report'`,
  metadata.date EAT) per day; bypass with `{ force: true }`. Preview HTML with
  `{ preview: true, date }`; backfill with `{ dates: [...], force: true }`.
