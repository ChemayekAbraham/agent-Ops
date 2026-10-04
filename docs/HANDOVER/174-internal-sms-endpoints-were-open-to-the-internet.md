# 174 - notify-advance-deduction and gmail-intake-silence-alarm were callable by anyone

**DB half LIVE 2026-09-30. Edge functions: code written, NOT yet deployed (see Order).**

## Problem
Both edge functions send SMS/email from WELILE's sender using the service role, and neither checked
who was calling. Their DB callers authenticated with the **public anon key** (it ships in the client
bundle), so anyone could POST `{agent_id, amount}` to `notify-advance-deduction` and text an agent a
fake "advance deduction" message, or hit `gmail-intake-silence-alarm` and fire its alert SMS/email.
Found 2026-09-30 when a Lovable status check returned 400 (function validation) instead of 401 for an
unauthenticated call. `sms-forwarder-ingest` was already fine (own token, 401).

## Fix
- New `supabase/functions/_shared/requireServiceRole.ts`: requires the service-role key, either an exact
  constant-time match with `SUPABASE_SERVICE_ROLE_KEY` or a token the auth admin API accepts (so a
  legacy-format vault key survives a rotation). Anything else gets 401.
- Both functions call it right after the OPTIONS check.
- Migration `20260930190000_internal_sms_endpoints_require_service_role.sql` switches every caller from
  the hard-coded anon JWT to vault secret `email_queue_service_role_key` (same source
  `notify_merchants_new_withdrawal` uses): `sweep_agent_advance_recovery`,
  `send_daily_advance_deduction_summary`, `sms_advance_deduction_on_ledger`, and cron job
  `gmail-intake-silence-alarm-every-10min` (altered in place with `cron.alter_job`). None of the three
  functions is in `critical_function_baselines`, so no re-baseline was needed. The migration raises if a
  literal is not found or a JWT is left behind.
- If the vault secret is ever missing the header becomes `Bearer ` and the endpoint refuses: safe-fail.

## Order (matters)
1. Migration first (applied live 2026-09-30): callers now send a service key to the still-open functions.
2. THEN deploy `notify-advance-deduction` and `gmail-intake-silence-alarm`. Deploying first would make
   every advance SMS and the silence alarm return 401.

## Verify
```sql
-- no caller still carries the public key
select proname from pg_proc where prosrc ilike '%notify-advance-deduction%' and prosrc ilike '%eyJhbGci%';
select jobname from cron.job where command ilike '%eyJhbGci%' and command ilike '%gmail-intake-silence-alarm%';
-- after deploy: next cron tick should be 200, not 401
select status_code, created from net._http_response order by created desc limit 5;
```
Anonymous call to either endpoint must now return 401.

Related: [`170-gmail-intake-silence-alarm.md`](./170-gmail-intake-silence-alarm.md), [`172-advance-deduction-daily-sms-summary.md`](./172-advance-deduction-daily-sms-summary.md).
