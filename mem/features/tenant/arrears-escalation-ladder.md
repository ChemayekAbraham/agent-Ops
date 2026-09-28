---
name: Tenant arrears escalation ladder
description: Daily Rent Plan arrears chase — tenant SMS day 1 then every 3rd day, agent SMS + agent_task from day 3, calling-centre to_call row from day 7
type: feature
---

Edge function `tenant-arrears-escalations`, cron `tenant-arrears-escalations-daily-0730-eat` (`30 4 * * *` = 07:30 Kampala, 30 min after PAYMENT_MISSED). Migration `20260928090000_arrears_ladder_schedule_and_reminder_sms_controls.sql` replaces the older `tenant-arrears-escalations-0700-eat` job if it exists.

SMS controls (system_config, `_shared/reminderSmsControls.ts`, shared with `tenant-payment-notices` mode=missed): `reminder_sms_enabled` (kill switch, missing row = OFF, re-read before every send), `reminder_sms_max_per_tenant_per_day` (1, across arrears + PAYMENT_MISSED), `reminder_sms_max_per_run` (400, largest arrears first). They gate SMS only; agent tasks and call rows still get raised. Reminder copy is checked against a promo / top-up / "repay up to 70%" blocklist before sending.

Source of truth: `v_rent_plan_arrears` (Kampala-day pinned, clamped at real outstanding), filtered `days_behind >= 1 and arrears_ugx > 0`. Plans with an `active` `rent_repayment_pauses` row (no `resume_on`, or `resume_on >= today`) are skipped.

Three stages, all idempotent through `tenant_arrears_escalations.dedupe_key` (unique):
1. `tenant_sms` — one SMS per tenant per day covering all their plans, fired when worst `days_behind % 3 == 1` (days 1, 4, 7, 10 …). Copy names the arrears, the days behind and the Trust Score consequence.
2. `agent_escalation` — collecting agent (`assigned_agent_id` else `agent_id`) texted once per day when any of their plans is >= 3 days behind and worst `days_behind % 3 == 0`; also raises an `agent_tasks` row (`task_type = 'arrears_followup'`, due today, priority high at >= 7 days).
3. `call_task` — inserts a `cc_cycle_rows` row (`state='to_call'`, `priority_value = arrears_ugx`) into the newest open `cc_call_cycles` tenant cycle for plans >= 7 days behind; worst plan per tenant, largest arrears first, capped 60 per run. The cycle/subject unique index dedupes; no open tenant cycle means the stage records an error and raises nothing.

`{"dry_run": true}` previews every message and writes nothing. Function never touches wallets, plans, repayments or collections.

Gotcha: `profiles` contact lookups are chunked 100 ids at a time — a large `in` list is sent in the query string and one failed batch previously made every recipient look phoneless and silently skipped.
