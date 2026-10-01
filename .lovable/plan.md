# ENGREP-LIVENESS-SWEEP-01 — one migration, liveness re-check window widened

## Fingerprint result (verified against the live database, read-only)

- `public.user_roles.enabled` — **exists** ✔
- `public.engrep_catalog_snapshot` — **exists** ✔
- `public.engrep_reevaluate_liveness(date)` — **exists** ✔ (identity args: `p_window date`), so the loop call is type-correct
- cron job **40897** — **exists**, active, `engrep-reeval-liveness-1730-eat`, schedule `30 14 * * *`, command currently `select public.engrep_reevaluate_liveness((current_date - 3));` — matches the instruction's premise
- `public.engrep_windows` — has all referenced columns (`granularity`, `period_start`, `locked_at`); all are usable as written

## File to create

- `drizzle/migrations/0375_engrep_reevaluate_liveness_recent.sql` (next free number; 0374 exists)

Generated companions (Drizzle snapshot under `drizzle/migrations/meta/`, `_journal.json`, and `src/integrations/supabase/types.ts`) change only as produced by the migration tooling.

## Content

The SQL from the instruction will be written **verbatim, unchanged**: the new
`public.engrep_reevaluate_liveness_recent(p_days integer default 7)` function (loop over unlocked day windows from `v_today - p_days` through `v_today`, summing `engrep_reevaluate_liveness(period_start)`), the revoke/grant (execute to `service_role` only), `cron.alter_job(40897, ...)` switching the job to `select public.engrep_reevaluate_liveness_recent(7);`, and the final immediate `select public.engrep_reevaluate_liveness_recent(7);`.

Nothing else is touched: no edits to `engrep_reevaluate_liveness`, `engrep_apply_zeroing`, or any other function/table/trigger/policy; no migration other than 0375 is created or re-run.

## Would anything fail?

- No. Every object the SQL references exists with a compatible signature; `cron.alter_job` with named arguments and job 40897 is valid.
- One behavioural note (not a failure): the final `select public.engrep_reevaluate_liveness_recent(7)` executes real re-evaluation work the moment the migration is applied — it re-checks today's window plus the previous 7 days immediately. Per the instruction this is intended and stays in the migration as written.
- Fence check: the migration file contains only the SQL above; no data writes, no function execution, no portfolio approvals outside it.

## Execution steps (after approval)

1. Call the migration tool with name `engrep_reevaluate_liveness_recent` and the SQL above as the query.
2. Read back the tool result for the applied file path and confirm success; if the types refresh fails, regenerate types.
3. Report the applied file path.
