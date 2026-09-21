# 88 — 2026-09-21: two-day financial-ops audit — two 09-19 migrations were never applied to production, applied now

**Both fixes below were blocked from landing in production on 2026-09-19 by the same "Modify
Shared Resources" classifier flag noted in docs 62/63/72/73/74/75/84. Confirmed both files were
already committed to the repo (0e43df4e0f) but absent from the live database on 2026-09-21.
Applied directly against production this session; both verified live.**

## 1. `email_queue_dispatch()` — fifth occurrence of the self-cancel regression, now actually fixed and re-baselined

Doc 84 diagnosed a fourth self-cancel regression on 2026-09-19 (docs 18, 66 §1 cover the first
three) and wrote migration `20260919060000_refix_email_queue_dispatch_self_cancel_regression_v4.sql`,
but the `CREATE OR REPLACE FUNCTION` / `cron.schedule` pair was blocked from direct application.
Re-checked live on 2026-09-21, two days later: **still broken** — `pg_get_functiondef` still showed
the `cron.unschedule`-from-inside-itself body, and `cron.job` had zero rows for
`process-email-queue`. No fallback background polling for two full days (mitigated the whole time
by `email_queue_wake()`'s inline dispatch on every enqueue — confirmed both `pgmq` queues stayed
empty throughout, so no email was actually stuck).

Applied migration 20260919060000's SQL directly against production:
- Reapplied doc 18 Fix #1 (never self-disarm).
- Re-armed `cron.schedule('process-email-queue', '5 seconds', ...)`.
- Re-baselined `critical_function_baselines` and resolved the open `critical_function_drift_alerts`
  row in the same statement batch, per doc 84's own warning not to split these.

Verified live 2026-09-21 05:02 UTC: `pg_get_functiondef` no longer contains `cron.unschedule`,
`cron.job` has one active row for `process-email-queue` on a 5-second schedule, and the drift alert
is resolved.

**If this comes back a fifth time**, the fix pattern is identical every time — see doc 18's Fix #1.
What's still unexplained is *how* the live body keeps reverting with no migration file recording
the change (checked via `git log -S` on the disarm string, per doc 84) — that's a live-editing or
rollback mechanism outside this repo's migration history, not a code bug in the fix itself.

## 2. Financial Ops "freeze withdrawals by category" — shipped UI, dead on arrival for two days

Doc 87 (built 2026-09-19, same day) added a Financial Ops liquidity control: freeze/unfreeze a
pending Cash Out withdrawal by category so operators can pay some requests now and hold the rest,
even after a cashout agent has claimed the payout. The frontend (`ApprovalQueue.tsx`) and the
`approve-withdrawal` edge function gate (`wr.frozen` check) were both fully committed and live. The
migration adding the underlying columns and trigger
(`20260919200000_withdrawal_request_category_freeze.sql`) was blocked the same way as above and
never applied.

**Practical impact for two days (2026-09-19 20:23 → 2026-09-21 05:xx UTC):** every "Freeze" or
"Unfreeze" click in the Approval Queue's Cash Out tab failed with a Postgres error (`column
"frozen" does not exist`), surfaced to the operator as a thrown error — **not** a silent no-op.
`wr.frozen` in `approve-withdrawal` was always `undefined`/falsy (the function does
`.select("*")`, so a missing column doesn't error the fetch — it just never blocked anything). Net
effect: **the freeze feature never worked, but it also never gave a false sense of a hold being in
place** — operators got an explicit error, not silent failure of the block itself. No withdrawal
was ever actually frozen in this window, so nothing needs backfilling.

Applied migration 20260919200000's SQL directly against production: added the five `frozen*`
columns (default `frozen = false`, so nothing existing changed behavior), the partial index, and
`trg_enforce_no_progress_on_frozen_withdrawal`.

Verified live 2026-09-21: all five `frozen*` columns present on `withdrawal_requests`, trigger
`trg_enforce_no_progress_on_frozen_withdrawal` wired. Feature is now live and usable from the
Financial Ops Approval Queue as designed in doc 87.

## 3. Transaction rollback spike (2026-09-19) — confirmed real, confirmed one-day, root cause still open

Doc 84 §2 found a genuine (not artifact) rollback-rate spike on 2026-09-19: ~37–49% rollback rate
depending on measurement window, against a normal ~4–6% baseline, and disproved the report's own
hypothesis (wallet cache/drift cron jobs — zero failures across all four candidate jobs in the
same window). Re-checked `db_stat_snapshots` on 2026-09-21:

| Day | Commits | Rollbacks | Rollback rate |
|---|---|---|---|
| 2026-09-18 | 1,737,588 | 108,197 | 5.9% |
| 2026-09-19 | 1,163,871 | 434,321 | 27.2% |
| 2026-09-20 | 1,245,553 | 55,220 | 4.2% |

**One-day spike, already resolved by 2026-09-20 — did not need intervention, only confirmation.**
Root cause is still unknown and doc 84's conclusion stands: needs actual Postgres error-log
inspection (Supabase dashboard → Logs → Postgres Logs, filtered to `ERROR`/`FATAL` for
2026-09-19), which is outside this tool's reach. Given it self-resolved and the volume (400K+
rollbacks in one day) implies one hot path rather than a diffuse issue, this is worth a log-based
post-mortem but is not an active incident.

## 4. Other open items noticed, not touched this pass

`critical_function_drift_alerts` has three older unresolved rows predating this 2-day window —
`ensure_payout_destination(...)` (2026-09-15), `enforce_withdrawal_destination_verified()`
(2026-09-14), `submit_withdrawal_request(...)` and `enforce_withdrawal_payout_account_lock()`
(both 2026-09-14). Not investigated this pass; flagging so a future audit doesn't assume they were
checked. All four are withdrawal/payout-destination functions, same subsystem as item 2 above —
worth a dedicated pass given the pattern of silent live-body drift this folder keeps finding.

The rest of 2026-09-19's financial-ops-adjacent work (docs 85/86: gibberish-name referral ring
purge and bot-referral-ring hunter v2; the National-ID-link auto-verify migrations) landed
normally through the standard pipeline — confirmed their functions exist live and, for
`payout_name_match_report`, confirmed the live body matches the fuzzy/subset-tolerant fix (doc
87's neighbor, migration `20260919171500`). Not a re-audit of their business logic, only an
existence/landing check.

---

## Verify this is still working

```sql
-- email_queue_dispatch
select pg_get_functiondef(oid) like '%cron.unschedule%' as still_broken
from pg_proc where proname = 'email_queue_dispatch'; -- expect false
select jobid, active from cron.job where jobname = 'process-email-queue'; -- expect one active row

-- freeze columns
select column_name from information_schema.columns
where table_name = 'withdrawal_requests' and column_name like 'frozen%'; -- expect 5 rows
select tgname from pg_trigger
where tgrelid = 'public.withdrawal_requests'::regclass
  and tgname = 'trg_enforce_no_progress_on_frozen_withdrawal'; -- expect one row
```

## What not to do

- Don't assume a migration file being committed to the repo means it's live — this folder has now
  hit that gap twice in the same day (09-19) for reasons unrelated to each other's content, purely
  because of the "Modify Shared Resources" classifier block on direct production writes from that
  tool. Always re-verify against the live database, per the standing repo-vs-production gotcha.
- Don't re-litigate the rollback spike as an active incident — it was real but is already over as
  of 2026-09-20. Treat it as a log-based post-mortem task, not a P1.
- Don't touch `ensure_payout_destination`/`enforce_withdrawal_destination_verified`/
  `submit_withdrawal_request`/`enforce_withdrawal_payout_account_lock` drift alerts without a
  dedicated audit — they weren't checked this pass and predate the 2-day window this doc covers.
