# 172 — SMS for advance deductions taken at credit time and withdrawal time (daily summary, superseded by one SMS per deduction)

> **Update 2026-09-30 (later): the daily summary below is superseded.** The CFO asked for an SMS on every deduction after Ian's UGX 250,000 withdrawal-time collect (14:33) arrived with no text. Migration `20260930170000_advance_deduction_sms_per_deduction.sql` adds `trg_sms_advance_deduction` (AFTER INSERT on `general_ledger`, only the two wallet legs described below) which posts to `notify-advance-deduction` `mode=deduction`; the edge function reads the balance after commit and texts "UGX X was deducted from your wallet on DD Mon HH:MM toward your Agent Advance. Remaining balance UGX Y." The daily cron `advance-deduction-daily-sms-summary` is unscheduled so nothing is texted twice; the summary function and tables stay. The cron and sweep paths still send their own SMS and are not matched. One busy evening can mean many texts (Ian had 10 on 29 Sep); that is what was asked for. Everything below describes the daily summary as built.

# (original) One daily SMS for advance deductions taken at credit time and withdrawal time

**Status: LIVE 2026-09-30.** Edge function `notify-advance-deduction` deployed via Lovable (commit `a2721ab7bb`), then migration `20260930150000_advance_daily_deduction_sms_summary.sql` applied via `query_database`. Verified: cron `advance-deduction-daily-sms-summary` active on `0 18 * * *`, function present, log and run tables empty. First run is 30 Sep 18:00 UTC; the SMS wording has not yet been seen end to end. Lovable also made two type-only build fixes (`sms-forwarder-ingest`, `rent-plan-transition-notices/messages_test.ts`, commit `216cda68bc`); `sms-forwarder-ingest` was not redeployed.

## Why

Ian Muhwezi (`3d78f1f8-f690-4fe8-bb2e-202f3ef2ecb0`) said he was deducted on 29 Sep, the balance didn't fall, and he got no SMS. Investigation (read-only, live DB):

- The balance did fall: 4,797,712.08 → 4,743,152.08 on 29 Sep, ten deductions, UGX 54,560. Every one has an `agent_repayment` wallet debit and an `agent_advance_repayment` platform credit. The amount is about 1% of his 4.7M balance, so it is hard to see.
- No SMS existed for any of them. All ten came from `recover_agent_arrears_from_credit`, which writes an in-app notification only. SMS exists only for the daily cron (`process-agent-advance-deductions`), the 16:50 UTC sweep, and the midnight "could not be collected" message.
- The 28 Sep UGX 120,000 taken 14 minutes after Finance credited him is the withdrawal-time collect ("Advance installment collected before withdrawal"), working as designed.
- Old notifications show ref `5A1A60B0` and "remaining 2,480,556" because handover 150 later moved those 13 deduction rows to the 7 Sep advance. The statement is correct; the sent notifications were true when sent and were left alone.

No data was wrong, so no data was changed.

## What was built

| Piece | Behaviour |
|---|---|
| `send_daily_advance_deduction_summary()` | Sums, per agent, the wallet `agent_repayment` legs described "Missed advance repayment auto-recovered from new earning" or "Advance installment collected before withdrawal" since the previous run, and calls `notify-advance-deduction` once per agent. |
| Rolling window | Start = latest `advance_deduction_sms_summary_runs.window_end` (24h back on the first run). Deductions after the 21:00 run go into the next SMS; none are dropped or counted twice. |
| `advance_deduction_sms_summary_log` | One row per agent per window, unique on `(agent_id, window_end)`. Records amount, payment count and the balance quoted. |
| Cron `advance-deduction-daily-sms-summary` | `0 18 * * *` = 21:00 Kampala. |
| Edge function `daily_summary` mode | "WELILE: UGX 55,360 was deducted from your wallet in 11 payments in the last 24 hours toward your Agent Advance. Remaining balance UGX 4,739,292. See your app for each deduction." Says "fully repaid" when nothing is left. The old wording is unchanged for the sweep. |

Not counted, on purpose: the 6-hourly cron and the 16:50 sweep, which already send their own SMS. Counting them would double-text.

Nothing changes to any deduction, cap, balance or wallet movement. Balance quoted = sum of the agent's `active`/`overdue` advances, the same figure the dashboard shows.

## Dry run (read-only, 30 Sep)

The window query over the last 24h returns Ian 11 payments / UGX 55,360, then 9 more agents (largest 23 payments / 29,394). Roughly 10+ agents would be texted on the first run.

## Deploy order (done 30 Sep)

1. Deploy `notify-advance-deduction` (publish alone does not deploy edge functions; use the Lovable prompt).
2. Apply the migration.
3. Still to verify after the first run: `select * from cron.job where jobname='advance-deduction-daily-sms-summary'` returns one row. After 18:00 UTC, `advance_deduction_sms_summary_log` has one row per agent and `sms_delivery_log` has source `advance_daily_deduction_summary`.

## Watch

- SMS credit: this adds one text per deducted agent per day. Most historical SMS failures were out of credit or rate limits.
- The function embeds the anon JWT inline, copied from `sweep_agent_advance_recovery` (already noted there as worth a separate look).
- If a run is missed, the next one covers the longer window in a single SMS.
