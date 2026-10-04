# 103 — Permanent fix for the recurring `email_queue_dispatch` self-cancel regression: auto-remediation, not another manual re-fix

**Applied and verified live 2026-09-22.** Josh asked to "find the permanent solution" after doc
101 fixed this the sixth time. Six occurrences between 2026-09-13 and 2026-09-22 (docs 18, 66, 84,
88, 101), each an identical revert of `email_queue_dispatch()` back to a self-cancelling variant
(`PERFORM cron.unschedule('process-email-queue')` on the empty-queue branch), always applied
directly against production with **zero migration file ever recording the revert** — same finding
every single time, documented as "still unexplained" in doc 101.

## What was actually investigated (root cause search, inconclusive)

Before building anything, tried to find the actual mechanism:

- `git log --all -S` on the disarm string, across the whole repo (not just migrations): only the
  five documented fix commits and the original 2026-04-13 baseline. No committed file ever
  reintroduces it.
- `pg_event_trigger`: no custom DDL audit trigger exists — Postgres itself keeps no record of who
  ran a given `CREATE OR REPLACE FUNCTION`.
- `cron.job` command text: no self-healing/reconciliation cron job embeds a stale `CREATE OR
  REPLACE FUNCTION` for this function (checked all jobs whose `command` mentions
  `email_queue_dispatch` or `CREATE OR REPLACE FUNCTION` — only the expected `SELECT
  public.email_queue_dispatch();` job exists).
- `supabase_migrations.schema_migrations` (the table the Supabase CLI uses to track applied
  migrations): contains **only** the original `20260413153924_email_infra` row. **None of the five
  fix migrations (`20260913140000`, `20260914110000`, `20260918000000`, `20260919060000`,
  `20260922060000`) are recorded there at all** — every one of them was applied as raw SQL
  directly against production, exactly as each doc says, never through a tracked migration
  pipeline. This doesn't explain the *revert* mechanism, but it does confirm there is no
  CLI-level record or checksum enforcement backing any of these functions — `critical_function_baselines`
  (doc 17) is the only thing watching.
- Checked Lovable's edit history (`list_edits`) around the exact detection window (5th fix at
  2026-09-21 05:02 UTC, 6th regression's drift alert opened 06:30 UTC same day): no edit in that
  window touches `email_queue_dispatch`, `process-email-queue`, or any SQL migration by name — the
  `ai_update` edits in that window are all UI (map pins, house cards). No smoking gun found.
- Checked `mcp__lovable__get_project_knowledge`: no stale project-knowledge text describes the
  self-cancel design as intentional (that would have explained an LLM "restoring" it).

**Conclusion: the exact actor/mechanism remains unidentified**, same as every prior doc's
"still unexplained" note. Given that, the actionable fix is not "find the culprit" (six attempts
across four people/sessions haven't) but **make the recurrence harmless regardless of cause.**

## What was built: auto-remediation, not just detection

`critical_function_baselines`/`scan_critical_function_drift()` (doc 17) already re-scans every
watched function and detects a hash mismatch — but it only ever alerted. It never had the actual
correct function body on hand, only a hash, so every occurrence needed a human to notice the
alert and manually reapply the identical fix.

Migration `20260922070000_email_queue_dispatch_auto_remediation.sql`:

1. Adds two columns to `critical_function_baselines`: `canonical_body text` (the exact
   `pg_get_functiondef()` output of the correct version) and `auto_remediate boolean DEFAULT
   false`.
2. Rewrites `scan_critical_function_drift()`: on a hash mismatch for a row with `auto_remediate =
   true` and a non-null `canonical_body`, it now `EXECUTE`s the stored canonical body immediately
   (`CREATE OR REPLACE FUNCTION` is idempotent and safe to replay), re-hashes, and — if that
   actually restored the expected hash — logs the episode as an **already-resolved** alert
   (`resolution_note = 'auto-remediated: ...'`) plus a `critical_function_drift_auto_remediated`
   system event, instead of leaving it open. If remediation isn't enabled for that function, or
   the remediation attempt itself doesn't produce the expected hash, it falls back to the original
   alert-only behavior unchanged.
3. Enables `auto_remediate = true` **only** for `email_queue_dispatch()`, with `canonical_body`
   set to the current (sixth-fix, doc 101) live body. The other five baselined functions
   (withdrawal gate, payout destination verification, interest authorization, two withdrawal
   triggers) stay alert-only — those are money/security-critical and a deliberate future change to
   one of them must still go through a human re-baseline (doc 17's existing rule). Auto-reverting
   those on drift could silently fight a legitimate future change; `email_queue_dispatch`'s design
   has been unchanged and unambiguous across five prior fixes and its worst-case failure mode is
   cosmetic (keeps polling every 5 seconds — never a money-movement risk), so it's the one function
   where auto-remediation is unambiguously safe.
4. Tightens `scan-critical-function-drift`'s schedule from every 15 minutes to every 5
   (`cron.alter_job`, same jobid 38042) — the scan is cheap (a hash of ~6 small function bodies),
   and a faster cadence directly shrinks the worst-case window any revert (remediated or not) can
   sit live.

**Caught one bug building this:** the first draft hand-transcribed the canonical body as a SQL
literal in the migration. Its hash didn't match `expected_sha256` — a whitespace/transcription
difference invisible on read. That would have made *every* future remediation attempt look like it
failed (`v_post_remediation_hash` never equal to `expected_sha256`), permanently falling back to
alert-only with no visible error. Fixed by deriving `canonical_body` from
`pg_get_functiondef('email_queue_dispatch()'::regprocedure)` directly in SQL instead of typing it
out — guaranteed byte-identical to what's live and hashed. **Anyone extending auto-remediation to
another function: never hand-type `canonical_body`, always pull it from the live, verified-correct
function.**

## Verified live

- Built and ran a disposable test: created `public._test_auto_remediation_dummy()`, baselined it
  with `auto_remediate = true`, broke it (`CREATE OR REPLACE` to a different body), called
  `scan_critical_function_drift()` manually. Result: `remediated_count: 1`, the dummy function was
  back to its correct body immediately, and `critical_function_drift_alerts` had a new row with
  `resolved_at` already set and the auto-remediation note — all in the same scan, no human action.
  Deleted the dummy function and its baseline/alert rows afterward; nothing production-facing was
  touched by the test.
- `email_queue_dispatch()`'s baseline row: `auto_remediate = true`, `canonical_body`'s hash matches
  `expected_sha256`, and the live function's hash matches both.
- `cron.job`: `process-email-queue` still active on its 5-second schedule (jobid 41486, untouched),
  `scan-critical-function-drift` now on `*/5 * * * *` (jobid 38042, same job, schedule altered in
  place).

## What not to do

- Don't extend `auto_remediate = true` to any of the other five baselined (money/security)
  functions without separately deciding that's actually wanted — auto-reverting a deliberate future
  change to `submit_withdrawal_request` or the payout-destination gate would be actively dangerous,
  not a safety net.
- Don't hand-type a `canonical_body` value in a future migration — derive it from
  `pg_get_functiondef()` against the live, just-verified-correct function, per the mistake caught
  above.
- If `email_queue_dispatch` is ever deliberately redesigned, update `canonical_body` and
  `expected_sha256` together in that same migration — otherwise the auto-remediator will revert the
  deliberate change back within one scan cycle (now ≤5 minutes).
- Don't treat this as having found the root cause. It hasn't been found across six occurrences and
  a dedicated search this pass. This makes the unknown recurrence self-healing, not solved.
