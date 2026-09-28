# Tenant Ops Workspace — security audit

Generated 2026-09-28 against project `43e6c2e1-18a6-4503-badb-5bb6c23491cc`, by direct inspection of `pg_class`/`pg_policies`/`pg_proc`/`aclexplode` — not by reading migration source, so this reflects what is actually live, not what a migration file claims. Re-run the queries in `docs/TOPS_BUILD_LOG.md`'s 2026-09-28 entry to refresh this after any new `tops_*` object is added.

**Bottom line: every one of the 13 `tops_*` tables has RLS enabled with at least one explicit policy, and none of the 49 `tops_*` functions is executable by `anon`.** Nothing needed fixing this task — see "Findings" at the end for the one intentional exception and the one pre-existing, already-documented default-ACL fact restated here for completeness.

## Tables

All 13 have `relrowsecurity = true`. Policy list (role always `authenticated`; no table has a policy granted to `anon` or `public`):

| Table | Policies |
|---|---|
| `tops_call_outcomes` | SELECT (tops roles), INSERT (`recorded_by = auth.uid()` AND tops roles) |
| `tops_collection_anomalies` | SELECT (tops roles) |
| `tops_collection_expectations` | SELECT (tops roles) |
| `tops_float_adequacy_snapshots` | SELECT (tops roles) |
| `tops_instalment_settlements` | SELECT (tops roles) |
| `tops_metric_definitions` | SELECT (tops roles) |
| `tops_notifications` | SELECT (own row OR tops roles), UPDATE (own row only) |
| `tops_plan_clock` | SELECT (tops roles) |
| `tops_plan_instalments` | SELECT (tops roles) |
| `tops_promises_to_pay` | SELECT (tops roles), INSERT (`taken_by = auth.uid()` AND tops roles) |
| `tops_restructure_register` | SELECT (tops roles) |
| `tops_tenant_brief_log` | SELECT (tops roles) |
| `tops_work_items` | SELECT (tops roles) |

"tops roles" = `has_role(auth.uid(), r)` for `r IN ('tenant_ops','operations','coo','cfo','ceo','super_admin')`, ORed together — the same six-role check used everywhere in this build.

**Why 8 of the 13 tables have only a SELECT policy, no INSERT/UPDATE/DELETE policy:** every write to them goes through a `SECURITY DEFINER` function owned by `postgres` (e.g. `tops_build_plan_instalments`, `tops_resolve_plan_clock`, `tops_allocate_collection`, `tops_detect_collection_anomalies`, `tops_refresh_work_items`, `tops_snapshot_agent_float_adequacy`). `postgres` is a superuser role in this database, which bypasses RLS entirely regardless of policy — so no write policy is needed or would even be consulted. The two tables with a client-facing INSERT policy (`tops_call_outcomes`, `tops_promises_to_pay`) are the two genuinely written directly by an authenticated user's own session (logging a call outcome, taking a promise-to-pay), not through a function — and both require the inserted row's own actor column to equal `auth.uid()`.

**Known, already-documented, unrelated to this audit:** every `tops_*` table also shows `authenticated` holding INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN grants at the `GRANT` level (a schema-wide default-privilege auto-grant, first recorded in this log on 2026-09-26 and reconfirmed live on every task since). This is inert: RLS is enabled and only the policies above exist, so Postgres denies any command with no matching policy. Rows also show `sandbox_exec`/`sandbox_exec_<id>`/`claude_investigator` holding SELECT/INSERT — these are platform tooling roles (the query-execution and read-only-investigation tools this build is developed through), not part of the application's real authentication surface (`anon`/`authenticated`), and out of scope for this audit. No `anon` grant exists on any `tops_*` table, checked explicitly.

## Functions

All 49 `tops_*` functions are `SECURITY DEFINER`, owned by `postgres`, with `SET search_path = public`. **Zero have `anon` in their EXECUTE grantee list** (checked explicitly, not sampled). 35 are granted to `authenticated` (client-facing); 14 are internal-only (no `authenticated` grant — reachable only via `postgres`/`service_role`, i.e. from cron or from another `SECURITY DEFINER` function).

**Every client-facing function has an internal `has_role(auth.uid(), ...)` check in its body; every internal-only function does not** — a 1:1 correlation, confirmed by scanning `pg_proc.prosrc`, with exactly one intentional exception (`tops_is_workspace_enabled`, below). This is the lesson this build has carried since an earlier real bug: a `has_role`-gated function has no session/JWT under `pg_cron` (`auth.uid()` is `NULL`), so every cron-only function in this build is deliberately gate-free and relies on the EXECUTE grant alone as its access control.

### Client-facing (has_role-gated, granted to `authenticated`)

| Function | Args |
|---|---|
| `tops_acknowledge_collection_anomaly` | `p_anomaly_id uuid, p_note text` |
| `tops_agent_area_coverage` | `p_level text, p_limit integer, p_offset integer` |
| `tops_agent_arrears_book` | `p_as_at date` |
| `tops_agent_attainment` | `p_from date, p_to date` |
| `tops_agent_capacity_eligibility` | — |
| `tops_agent_float_adequacy` | `p_for_date date` |
| `tops_agent_integrity_signals` | `p_from date, p_to date` |
| `tops_area_book` | `p_level text, p_as_at date` |
| `tops_arrears_ageing` | `p_as_at date, p_bucket text, p_limit integer, p_offset integer, p_dir text` |
| `tops_assign_work_item` | `p_work_item_id uuid, p_assigned_to uuid` |
| `tops_blocked_items` | — |
| `tops_calling_gap` | — |
| `tops_calling_money_at_risk` | `p_tenant_ids uuid[]` |
| `tops_close_work_item` | `p_work_item_id uuid, p_outcome text` |
| `tops_collection_anomalies_list` | `p_status text` |
| `tops_collection_scoreboard` | `p_from date, p_to date` |
| `tops_collections_due_today` | `p_as_at date, p_limit integer, p_offset integer, p_sort text, p_dir text` |
| `tops_collections_movement` | `p_from date, p_to date, p_limit integer, p_offset integer` |
| `tops_escalate_work_item` | `p_work_item_id uuid, p_escalated_to uuid, p_note text` |
| `tops_never_billed` | `p_as_at date, p_limit integer, p_offset integer, p_dir text` |
| `tops_never_billed_summary` | `p_as_at date` |
| `tops_overnight_changes` | `p_as_at date` |
| `tops_pipeline_queue` | — |
| `tops_plan_pipeline_stages` | `p_rent_request_id uuid` |
| `tops_plan_position` | `p_rent_request_id uuid, p_as_at date` |
| `tops_plan_schedule_ledger` | `p_rent_request_id uuid` |
| `tops_portfolio_quality` | `p_as_at date` |
| `tops_promise_kept_rate` | `p_from date, p_to date, p_user_id uuid` |
| `tops_queue_latency` | `p_from date, p_to date` |
| `tops_resolve_collection_anomaly` | `p_anomaly_id uuid, p_note text` |
| `tops_seed_collection_expectations` | `p_days integer` — the one internal-*data* function granted to `authenticated` on purpose: it only rewrites the expectation *ranges* the detector checks against, never posts a ledger entry, and is meant to be re-run by a human when the real posting pattern legitimately changes, not by cron |
| `tops_set_plan_cadence` | `p_rent_request_id uuid, p_cadence text, p_reason text` |
| `tops_snooze_work_item` | `p_work_item_id uuid, p_new_sla_due_at timestamptz` |
| `tops_unknown_cadence_plans` | `p_limit integer, p_offset integer` |
| `tops_unmapped_tenants_worklist` | `p_limit integer` |

### Internal-only (no `authenticated` grant — cron or callee-only)

| Function | Has `has_role` check? |
|---|---|
| `tops_agent_float_adequacy_internal` | No — called only by the cron-driven `tops_snapshot_agent_float_adequacy` |
| `tops_allocate_collection` | No — called only by the cron-driven `tops_allocate_pending` |
| `tops_allocate_pending` | No — cron entry point |
| `tops_build_plan_instalments` | No — called by `tops_resolve_plan_clock`/`tops_set_plan_cadence`/cron |
| `tops_build_schedules_batch` | No — cron entry point |
| `tops_detect_collection_anomalies` | No — cron entry point |
| `tops_is_collection_reversed` | No — internal helper read by other functions |
| `tops_open_instalments_asof` | No — internal helper read by `tops_arrears_ageing`, `tops_collections_movement`, `tops_never_billed`, `tops_agent_arrears_book`, `tops_agent_float_adequacy_internal`, `tops_portfolio_quality` |
| `tops_plan_position_internal` | No — called only by the cron-driven work-items refresh |
| `tops_refresh_restructure_register` | No — cron entry point |
| `tops_refresh_work_items` | No — cron entry point |
| `tops_resolve_plan_clock` | No — called by cron and by `tops_set_plan_cadence` |
| `tops_resolve_promises` | No — cron entry point |
| `tops_snapshot_agent_float_adequacy` | No — cron entry point |

### Intentional exception

`tops_is_workspace_enabled()` — granted to `authenticated`, **no** `has_role` check. This is the kill-switch read (`docs/TOPS_RULES.md`'s "Kill switch" section): it reads one boolean from `system_config` so the workspace can decide whether to render at all, before it knows whether the signed-in user even holds a tops role. Gating it behind `has_role` would make the kill-switch itself fail closed for a legitimately-permissioned user whose role check has some other transient issue, and the value it exposes (a feature flag, not tenant/financial data) carries no confidentiality requirement. Every other function it gates access to is separately has_role-checked on its own.

## Findings

No fix was required in any `tops_*` object this task — the two invariants the brief asked to verify (every new table has RLS with explicit policies; no new `SECURITY DEFINER` function is executable by `anon`) were already true for all 13 tables and all 49 functions, checked individually rather than sampled. The only two facts worth recording are the pre-existing default-ACL grant (documented since this build's first task, reconfirmed here) and the one intentional has_role exception above — neither is a defect.
