# 247 — Email queue stopped after the PDPO cutover: `email_queue_dispatch()` still posted to the old project (2026-10-17)

**Status:** **APPLIED LIVE AND VERIFIED 2026-10-17** (~07:33 UTC by `execute_sql`, re-applied from the file by Josh afterwards). Migration `20261017100000_repoint_email_queue_dispatch_to_new_project.sql` is committed on `dev/email-queue-dispatch-repoint` (cut from `origin/lovable` 16e9f3b75a), **not pushed**; production already has the change, so the push only brings the repo in line. No edge function change.

## Symptom
An agent on the "Verify this device" (two-step) screen never received the 6-digit code by e-mail. Screenshot at 10:22 EAT (07:22 UTC); masked address `b…@gmail.com`.

## Cause
`public.email_queue_dispatch()` posted to the **old** project host `wirntoujqoyjobfhyelc.supabase.co/functions/v1/process-email-queue`, which no longer resolves after the cutover to `byrzshwlentqvktcksem`. Cron job 661 `process-email-queue` (every 5 s) kept reporting `succeeded` because `net.http_post` only queues the request; the failure showed up as `net._http_response.status_code IS NULL` (216 rows in 30 min).

Measured at 07:28 UTC on the new project:
- Last `sent` row in `email_send_log`: 07:09:35 UTC. Nothing after.
- 10 messages in `pgmq.q_transactional_emails`, oldest enqueued 07:11:42; 7 were `two-factor-code` (three to the user in the screenshot at 07:20, 07:22, 07:24).
- `process-email-queue` and `mcp` were deployed and ACTIVE (405 functions listed), so deploy state was not the problem. `user_2fa_challenges`, `suppressed_emails` and the Mailgun error log showed nothing relevant.

Why it came back: the function body was dumped and restored with the old URL, and the drift scanner's stored `canonical_body` (doc 18 / `20260922070000`, `auto_remediate = true`) carried the same old URL. Replacing the function alone would have been reverted by `scan_critical_function_drift()` within one scan interval.

## What changed
`supabase/migrations/20261017100000_repoint_email_queue_dispatch_to_new_project.sql`, in one transaction:
1. `CREATE OR REPLACE FUNCTION public.email_queue_dispatch()` with the new URL, body otherwise identical.
2. `critical_function_baselines` row for `email_queue_dispatch()`: `canonical_body` derived from the live function, `expected_sha256` recomputed, `baselined_by`/`note` set.
3. Open `critical_function_drift_alerts` for that function resolved.

The Mailgun key had also been rotated that day. `process-email-queue` reads `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_API_BASE` from secrets by name (`index.ts:239-241`); Josh set the new key on `byrzshwlentqvktcksem` **before** the dispatcher was fixed so the backlog would not hit Mailgun with a bad key. The same three secrets are read by ~15 report functions.

## Verification (07:34 UTC)
- Both pgmq queues at 0; the whole backlog flushed within about 6 s, 2FA codes included, every row `sent`, no `error_message` (so the new Mailgun key is accepted).
- Function and `canonical_body` contain `byrzshwlentqvktcksem`; hash matches the live body.
- 13 sent in the following 10 minutes.

## What to tell the user
Tap "Send a new code" and use the newest e-mail. The backlogged codes were delivered late (auth TTL is 15 min) and each resend invalidates the previous one.

## Open
- Companion to doc 245, which repointed the **code-side** project references (templates, session keys, `mcp` bundle, share worker). This doc is the **database-side** leftover: a function and a drift baseline restored from the dump with the old URL still inside them.
- **4 unresolved rows in `critical_function_drift_alerts`** on other functions, not touched here. Likely more cutover leftovers (old-project URLs or hashes baselined on the old database). Not investigated.
- **`apply_migration` fails on this project** with `42P10: no unique or exclusion constraint matching the ON CONFLICT specification` (rolled back cleanly). Suspected cause: `supabase_migrations.schema_migrations` lost its unique key in the dump restore. Not confirmed. Migrations applied through the tool are not recorded; this one was applied with `execute_sql`, so it has no `schema_migrations` row.
- No monitoring caught the stall: `gmail-intake-silence-alarm` covers Gmail intake only. A "transactional queue older than N minutes" alert would have flagged this at 07:15.
- Other functions or cron commands may still hold the old project ref. A scan of `public` functions found only this one; `cron.job` commands matching `wirntoujqoyjobfhyelc` found none. Vault secrets and edge-function bodies were not scanned.
