# 17. Safeguard — Critical function drift detection (2026-09-14)

**Status: live, verified end-to-end.**

---

## What this protects against

`email_queue_dispatch()`'s self-cancel fix (see
[`18-email-queue-dispatch-self-cancel-regression.md`](./18-email-queue-dispatch-self-cancel-regression.md))
was confirmed live, then **reverted directly against production** sometime before the next CTO
report ran — with no migration file recording the revert. It sat broken again for hours before
anyone noticed, purely because nothing was watching for a live function body to change out from
under its last deliberate migration.

`supabase/migrations/` not faithfully reflecting live production is a known, standing condition of
this project (see [`07-tribal-knowledge.md`](./07-tribal-knowledge.md) and
[`06-live-state-verification.md`](./06-live-state-verification.md)) — this doesn't try to fix that
generally. It gives a small, curated set of the most security/money-critical functions an early
warning when *their specific* live body silently diverges from what was last deliberately set.

---

## How it works

- `critical_function_baselines(function_signature, expected_sha256, note, baselined_at,
  baselined_by)` — one row per monitored function, keyed by its exact `regprocedure` signature
  (not bare name — several functions in this codebase are overloaded).
- `critical_function_drift_alerts` — one **active** (unresolved) row per function at a time; a
  unique partial index (`WHERE resolved_at IS NULL`) stops repeated scans from spamming a new row
  every 15 minutes while a drift is ongoing.
- `scan_critical_function_drift()` — scheduled via `cron` every 15 minutes. For each baseline,
  recomputes `sha256(pg_get_functiondef(oid))` and compares. A mismatch inserts one alert (if none
  is already active) plus a `system_events` row (`event_type =
  'critical_function_drift_detected'`); a function that returns to its baselined hash
  auto-resolves its own alert.
- A signature that no longer resolves at all (function dropped/renamed) is treated as drift too,
  with a `NULL` actual hash, rather than silently skipped.

**Extending coverage is a data change, not a code change** — insert a row into
`critical_function_baselines` with the function's exact signature and the sha256 of its current
(correct) `pg_get_functiondef()` output. No redeploy needed.

## Currently watched (seeded 2026-09-14)

| Function | Why |
|---|---|
| `email_queue_dispatch()` | The one that actually regressed. |
| `submit_withdrawal_request(numeric,text,text,text,text,text,text,text,uuid,text)` | Core withdrawal gate: balance check + destination verification. |
| `ensure_payout_destination(uuid,text,text,text,text,text,text,text)` | The NIN/destination-verification pipeline depends on this. |
| `apply_welile_homes_monthly_interest()` | Had zero auth check and was `anon`-executable until fixed the same day — see [`14-anon-executable-apply-welile-homes-interest.md`](./14-anon-executable-apply-welile-homes-interest.md). Watch for that gate disappearing again. |
| `enforce_withdrawal_payout_account_lock()` | Trigger: blocks changing an already-registered payout number. |
| `enforce_withdrawal_destination_verified()` | Trigger: blocks a self-service withdrawal to an unverified destination. |

---

## A real bug caught while building this

`text::bytea` in Postgres does **not** UTF-8-encode a string — it parses it as a bytea literal
(hex/octal escapes), which silently produces garbage for almost any real function body. The
correct cast is `convert_to(text, 'UTF8')`. Caught this because the seed `INSERT` failed outright
with `invalid input syntax for type bytea` rather than silently hashing something wrong — both the
seed insert and `scan_critical_function_drift()` itself use `convert_to`, not a direct cast.

---

## Verified end-to-end (not just deployed)

1. Seeded baselines from the current (correct) live bodies.
2. Ran `scan_critical_function_drift()` — clean, `drifted_count: 0`.
3. Inside a transaction, **reintroduced the exact old `email_queue_dispatch` self-cancel bug**,
   ran the scan again — caught immediately with the precise hash mismatch — then `ROLLBACK`.
4. Confirmed the rollback left the live function untouched and created **zero** stray alert or
   `system_events` rows (proving the whole test was non-destructive).

```sql
-- Anything currently drifted:
select function_signature, detected_at from critical_function_drift_alerts where resolved_at is null;

-- Manually trigger a scan right now:
select scan_critical_function_drift();
```

---

## What not to do

- Don't assume "the migration says X" means "production runs X" for anything **not** in this
  baseline table — this only watches six functions, deliberately, not the whole schema. Continue
  treating live-state verification (`06-live-state-verification.md`) as authoritative for
  everything else.
- Don't extend coverage to dozens of functions casually. Every addition is one more row scanned
  every 15 minutes and one more thing that can false-positive on a legitimate, deliberate change
  that simply wasn't re-baselined. Keep this to genuinely critical, fragile functions.
- If you deliberately change one of the six watched functions, **re-baseline it in the same
  migration** (update `critical_function_baselines.expected_sha256` to the new correct hash) —
  otherwise the very next scan will alert on your own intentional change.
