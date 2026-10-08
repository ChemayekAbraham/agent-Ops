# 205 — CTO report accuracy pass + SMS balance early warning (2026-10-08)

**BUILT 2026-10-08. Migration `20261008090000` not applied, `sms-balance-watch` not deployed or scheduled, `daily-cto-report` not redeployed.**

Triggered by the week-ending 2026-10-07 Board report and the 2026-10-07 daily CTO report disagreeing.

## CTO report (tech path only; board memo untouched)
- Health score: trusted day rollback rate >= 5% lowers Reliability and caps the headline at 84 (never "Healthy"). Authentication pillar uses people-based 7-day eventual sign-in success when available.
- Automations: failed-run rate includes ad-hoc (unscheduled) jobs from `J.failing`.
- "Notification delivery" relabelled "E-mail delivery (excludes SMS)"; SMS 30-day provider-rejection tile and KPI rows added.
- Median sign-in latency of 0 ms shown as "not measurable"; monthly actives marked unreliable (about 35k `profiles.last_active_at` were bulk-stamped; 7-day figure is fine).
- Recommendations: adds rollback, people-based sign-in, SMS rejection; no longer says to index the trust-score batch (runs every 2 h by design).
- PDF: footer line no longer overprints the next section title.

## SMS balance early warning
- Yoola returns the remaining balance in every send response. 2026-10-08: about 8,400 credits, about 4,300 burned per 24 h (about 2 days runway); balance touched 654 within the prior 48 h. Refusals ("insufficient fund") ran 1-5 Oct, none since 5 Oct 08:00 UTC.
- `get_sms_balance_runway()` (service role only) + `sms_balance_alerts` table; edge fn `sms-balance-watch` emails when runway < 48 h or balance < 6,000 (critical: < 18 h / < 2,000).
- **Still to do:** apply the migration, deploy the function, schedule hourly (copy the cron block from `20260817091438_*.sql`; not embedded here to avoid copying a key). Verify live objects after the push.

## Not done
Backup provider key (21 failures), missed advance-deduction reminder stream (13.4% failing), access-denied redirect loop (UI/guard, Gemini), randomUUID guard (Gemini). 100% sign-in is not reachable as "attempts": wrong passwords and unknown numbers are customer outcomes.

## Addendum: SMS failure alert counts final outcomes only (migration `20261008100000`, not applied)
`detect_sms_failure_alerts` counted every `sms_delivery_log` row, including attempts later rescued by another provider (Yoola accepted-but-unconfirmed, delivered by Africa's Talking: `final_accepted=true`). Over 7 days to 2026-10-08: 953 raw failed rows vs 622 final outcomes (+53%). It now drops rows whose `attempt_sequence < total_attempts`, the same rule `get_board_tech_memo` and `get_cto_daily_report` already use. The Board memo and daily CTO report were already correct; `get_messaging_usage_weekly_bundle` intentionally still counts raw rows (cost). Not in `critical_function_baselines`, so no re-baseline. Verify live after apply: `select detect_sms_failure_alerts()` should report `failed` close to the final-outcome count.
