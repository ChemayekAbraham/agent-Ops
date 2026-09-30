# 170 — Gmail intake silence alarm: a dead forwarding phone raised no alert

**BUILT 2026-09-30, not yet applied.** Files: `supabase/functions/gmail-intake-silence-alarm/index.ts`, `supabase/migrations/20260930090000_gmail_intake_silence_alarm.sql`. Deploy the edge function before applying the migration, so the first cron call finds it.

## Symptom

Overnight 2026-09-29/30 the phone that receives MoMo SMS and forwards them (IFTTT → Gmail → poller) went offline. Agents' float deposits stopped auto-crediting. Nobody was alerted; Josh found out from agents and spent the night crediting by hand.

## Root cause

The chain has one physical point of failure, and the only watchdog looked at the wrong thing. `gmail-poll-heartbeat` checks `gmail_poll_state.last_polled_at`, i.e. that the poller is running. With the phone dead the poller kept polling every minute and finding nothing, so it stayed "healthy". The last deposit email was ingested at 21:18 UTC on 09-29 and the poller cron was active throughout.

Two further defects found while checking live state, both meaning the old heartbeat could never have alerted anyway:

- The live `deposit_match_alerts_alert_type_check` did not allow `gmail_poll_stale`. Migration `20260926090000` rebuilt the list without it, so the heartbeat's alert upsert would fail.
- No `gmail-poll-heartbeat-every-15min` cron job existed in production.

## What was built

- `gmail-intake-silence-alarm` (cron every 10 min). Looks at the newest `gmail_transactions` row with `direction = 'in'`. If it is older than `threshold_minutes` (default 45) and the time is inside the active window (default 06:00–23:00 EAT), it upserts a critical `gmail_intake_silent` alert, emails `notify_emails` and SMSes `notify_sms_phones`. It repeats every `renotify_minutes` (default 60) while silent, and sends one recovery notice when intake resumes.
- Config in `gmail_intake_silence_config` (singleton, RLS on, service role only). **`notify_sms_phones` ships empty**, so the alarm is email-only until numbers are set. Set them, e.g. `update gmail_intake_silence_config set notify_sms_phones = array['0700000000'] where id = 1;`.
- Migration also restores `gmail_poll_stale` to the alert_type constraint (live list plus `gmail_poll_stale` and `gmail_intake_silent`) and schedules the heartbeat cron again.
- The alert text tells recipients to credit by TID only. When the phone reconnects IFTTT delivers a backlog in a burst (see doc 168), so a TID credited by hand can arrive again.

## Limits

- Detects silence, not cause. It cannot tell a dead phone from a quiet hour; the 45-minute threshold and active window are the trade-off. Tune in the config row.
- Does not recover missing deposits. Those live only in the MTN merchant statement, not in the database.
- Structural fix is MTN MoMo API callbacks (no phone). Not started.

## Verification

`npm run guard:all` passes. Not yet run against production: after applying, call the function once and check the response (`silent`, `silent_minutes`).
