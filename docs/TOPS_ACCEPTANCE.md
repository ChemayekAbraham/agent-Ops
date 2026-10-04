# Tenant Ops Workspace — acceptance report

Generated 2026-09-28 against project `43e6c2e1-18a6-4503-badb-5bb6c23491cc`. Every item below was verified by **running** it — a live RPC call, a self-contained SQL test (cloned fixture data inside `BEGIN...ROLLBACK`, confirmed to leave zero trace afterward), a real Playwright browser run, or a direct query against `pg_cron`/`pg_proc`/`pg_policies` — not by reading source and assuming. Where a check was necessarily static (a diff, a grep across migration files), that is stated plainly rather than dressed up as a live run.

The whole-effort baseline is commit `7780f9fc5e513d1a3fb553ddb8acfdabd99941cd~1` (2026-09-26, just before "Lay groundwork for a new tenant plan-tracking system" — the first commit that touches anything under this effort's own paths), compared against `HEAD` (`d7e7153904`, 2026-09-28). This repo is worked on by multiple people/agents in parallel (per `CLAUDE.md`'s own division-of-labor note), so a plain `git diff` across that whole calendar window touches **310 files** — the great majority unrelated commits by other contributors. Every check below is scoped to files that actually belong to this effort (`src/components/tenant-ops-workspace/**`, `src/pages/tenant-ops/workspace/**`, `src/hooks/tenantOpsWorkspace/**`, `supabase/migrations/*tops*`, `supabase/tests/*tops*`, `supabase/functions/tops-tenant-brief/**`, `docs/TOPS_*.md`, `e2e/tenant-ops-workspace-*.spec.ts`, and the guard-registration files), not the raw 310-file diff.

---

## NON-REGRESSION

### 1. Exactly two existing files changed, one route entry / one nav entry

**Scoped diff, this effort's own contribution to each file:**

`src/App.tsx` — 2 lines added: the lazy import and the `<Route>` line for `TenantOpsWorkspacePage`, which together are rule 11's "ONE route entry":
```diff
+const TenantOpsWorkspacePage = lazy(() => import('./pages/tenant-ops/workspace/TenantOpsWorkspacePage'));
...
+          <Route path="/tenant-ops/workspace" element={<RoleGuard allowedRoles={(['tenant_ops', 'operations', 'coo', 'ceo', 'super_admin'] as any)}><TenantOpsWorkspacePage /></RoleGuard>} />
```

`src/components/layout/executiveSidebarConfig.ts` — 1 line added, rule 11's "ONE nav entry":
```diff
+        { label: 'Tenant Ops Workspace', icon: Layers, id: 'tenant-ops-workspace',  route: '/tenant-ops/workspace' },
```

**PASS** for this effort's own edits — exactly the two files, exactly one route entry and one nav entry, both purely additive.

**Important, verified-by-diff finding, disclosed rather than hidden:** a plain `git diff` of these two files across the same window (pasted in full below) shows *additional* changes this effort did not make. `src/App.tsx` also gained a `PayrollApprovalGate`, a `ProxyPerformanceDashboard` lazy import, and two `/dashboard/agent/proxy*` routes; `executiveSidebarConfig.ts` also gained a new "Monitor" nav section, an "Agent Boutique" nav item (added twice), and — this is genuinely this effort's own earlier work — the one Tenant Ops Workspace line above. These are unrelated features from other concurrent work on this shared repo (this codebase is built by multiple agents/people in parallel), not something the Tenant Ops Workspace effort introduced, and they don't touch this effort's own route/nav entries. Flagging this because the task asked to "paste the diff," and the honest diff includes them.

Full diff, `src/App.tsx`:
```diff
@@ -67,6 +67,7 @@ const NationalIdLinkGate = optionalLazyWithRetry(() => import("@/components/noti
 const ConcernAssignmentGate = optionalLazyWithRetry(() => import("@/components/notifications/ConcernAssignmentGate"), "ConcernAssignmentGate");
 const FacilitationApprovalGate = optionalLazyWithRetry(() => import("@/components/requisitions/FacilitationApprovalGate"), "FacilitationApprovalGate");
 const StaffLoanApprovalGate = optionalLazyWithRetry(() => import("@/components/requisitions/StaffLoanApprovalGate"), "StaffLoanApprovalGate");
+const PayrollApprovalGate = optionalLazyWithRetry(() => import("@/hr/pay/PayrollApprovalGate"), "PayrollApprovalGate");
 
 const PsoFacilitationRegister = lazyWithRetry(() => import("@/pages/PsoFacilitationRegister"));
@@ -121,6 +122,7 @@ const Wishlist = lazy(() => import("./pages/Wishlist"));
 const AgentAnalytics = lazy(() => import("./pages/AgentAnalytics"));
 const AgentPartners = lazy(() => import("./pages/AgentPartners"));
 const ProxyAgentCommandCenter = lazy(() => import("./pages/agent/ProxyAgentCommandCenter"));
+const ProxyPerformanceDashboard = lazy(() => import("./pages/agent/ProxyPerformanceDashboard"));
 const FlashSales = lazy(() => import("./pages/FlashSales"));
@@ -334,6 +336,7 @@ const MyRequisitions = lazy(() => import('./pages/me/Requisitions'));
 const HRContractsPage = lazy(() => import('./hr/pages/ContractsPage'));
 const TenantDashboardLandingPage = lazy(() => import('./pages/TenantDashboardLandingPage'));
 const TenantNotificationAnalyticsPage = lazy(() => import('./pages/tenant-ops/TenantNotificationAnalyticsPage'));
+const TenantOpsWorkspacePage = lazy(() => import('./pages/tenant-ops/workspace/TenantOpsWorkspacePage'));
@@ -442,6 +445,7 @@ function GlobalOnboardingGates() {
       <ConcernAssignmentGate />
       <FacilitationApprovalGate />
       <StaffLoanApprovalGate />
+      <PayrollApprovalGate />
     </>
   );
@@ -512,6 +516,8 @@ function AppRoutes() {
           <Route path="/dashboard" element={<DashboardRedirect />} />
           <Route path="/dashboard/tenant" element={<Dashboard />} />
           <Route path="/dashboard/agent" element={<Dashboard />} />
+          <Route path="/dashboard/agent/proxy" element={<ProxyAgentGuard><ProxyPerformanceDashboard /></ProxyAgentGuard>} />
+          <Route path="/dashboard/agent/proxy/:section" element={<ProxyAgentGuard><ProxyPerformanceDashboard /></ProxyAgentGuard>} />
           <Route path="/dashboard/landlord" element={<Dashboard />} />
@@ -788,6 +794,7 @@ function AppRoutes() {
           <Route path="/coo/reports/tenant-ops"    element={<RoleGuard allowedRoles={['coo', 'super_admin', 'cto', 'manager']} requiredPermission="coo"><COOTenantOpsReport /></RoleGuard>} />
           <Route path="/coo/reports/tenant-portfolio-performance" element={<RoleGuard allowedRoles={['coo', 'super_admin', 'cto', 'manager']} requiredPermission="coo"><TppoPortfolioPerformanceReport /></RoleGuard>} />
           <Route path="/tenant-ops/notifications" element={<RoleGuard allowedRoles={['coo', 'super_admin', 'cto', 'manager', 'ceo', 'cmo', 'crm', 'cfo', 'operations', 'employee']}><TenantNotificationAnalyticsPage /></RoleGuard>} />
+          <Route path="/tenant-ops/workspace" element={<RoleGuard allowedRoles={(['tenant_ops', 'operations', 'coo', 'ceo', 'super_admin'] as any)}><TenantOpsWorkspacePage /></RoleGuard>} />
           <Route path="/coo/reports/tenant-notifications" element={<Navigate to="/tenant-ops/notifications" replace />} />
```

Full diff, `executiveSidebarConfig.ts`:
```diff
@@ -101,6 +101,15 @@ export const executiveSidebarConfig: Record<string, SidebarSection[]> = {
         { label: 'My Work', icon: ClipboardList, id: 'my-work' },
       ],
     },
+    {
+      title: 'Monitor',
+      icon: Activity,
+      collapsible: true,
+      defaultOpen: true,
+      items: [
+        { label: 'Agent Collections', icon: Activity, id: 'monitor-agent-collections' },
+      ],
+    },
   ],
@@ -133,6 +142,7 @@ export const executiveSidebarConfig: Record<string, SidebarSection[]> = {
           children: [
             { label: 'Welile Motorbikes', icon: Bike, id: 'agent-products-motorbikes' },
             { label: 'Welile Smartphones', icon: MonitorSmartphone, id: 'agent-products-smartphones' },
+            { label: 'Agent Boutique', icon: ShoppingBag, id: 'agent-products-boutique' },
           ],
         },
       ],
@@ -254,6 +264,7 @@ export const executiveSidebarConfig: Record<string, SidebarSection[]> = {
           children: [
             { label: 'Welile Motorbikes', icon: Bike, id: 'agent-products-motorbikes' },
             { label: 'Welile Smartphones', icon: MonitorSmartphone, id: 'agent-products-smartphones' },
+            { label: 'Agent Boutique', icon: ShoppingBag, id: 'agent-products-boutique' },
           ],
         },
         { label: 'Manual Requisitions', icon: ClipboardList, id: 'manual-requisitions' },
@@ -271,6 +282,7 @@ export const executiveSidebarConfig: Record<string, SidebarSection[]> = {
         { label: 'Partner Ops',   icon: Handshake,     id: 'reports-partner-ops',   route: '/coo/reports/partner-ops' },
         { label: 'Agent Ops',     icon: Users,         id: 'reports-agent-ops',     route: '/coo/reports/agent-ops' },
         { label: 'Tenant Ops',    icon: Home,          id: 'reports-tenant-ops',    route: '/coo/reports/tenant-ops' },
+        { label: 'Tenant Ops Workspace', icon: Layers, id: 'tenant-ops-workspace',  route: '/tenant-ops/workspace' },
         { label: 'Portfolio Performance', icon: BarChart3, id: 'reports-tenant-portfolio-performance', route: '/coo/reports/tenant-portfolio-performance' },
```

**Also disclosed:** `.claude/launch.json` changed (dev server port 5173→8080) during the same window — outside both permitted files. This is dev-tooling config, not product code, and matches the port every task this session has actually used to preview the app; almost certainly changed by someone configuring their own local dev server, unrelated to this effort's own work (no task this session needed to touch it — the working dev server was already on 8080 throughout). Disclosed for completeness, not defended as "permitted."

**Verdict: PASS** (this effort's own edits are exactly one route entry and one nav entry, purely additive) **with two disclosed, out-of-scope findings** (both files also carry unrelated concurrent work; a third file outside the two-file allowlist changed for an unrelated dev-tooling reason).

### 2. No existing database object altered; every migration is CREATE-only on `tops_*` objects

18 migrations exist under this effort (`ls supabase/migrations/ | grep tops`):

```
20260926160000_tops_plan_clock_and_instalments.sql
20260926170000_tops_plan_clock_resolver_functions.sql
20260926180000_tops_collection_allocation_functions.sql
20260926190000_tops_plan_position_and_schedule_ledger.sql
20260927100000_tops_collection_scoreboard.sql
20260927110000_tops_workspace_feature_flag.sql
20260927120000_tops_plan_pipeline_stages.sql
20260927140000_tops_today_and_collections_rpcs.sql
20260927150000_tops_promises_and_calling_gap.sql
20260927160000_tops_work_items.sql
20260927161000_tops_plan_position_internal_for_cron.sql
20260927170000_tops_agent_float_and_integrity.sql
20260927180000_tops_pipeline_queue.sql
20260927190000_tops_places.sql
20260927200000_tops_portfolio_quality_and_restructure_register.sql
20260927210000_tops_tenant_brief_log.sql
20260927220000_tops_collection_anomaly_detection.sql
20260927230000_tops_cadence_remediation_and_never_billed_summary.sql
20260928100000_tops_pagination_and_sort_hardening.sql
```

Ran, across all 18 files: `grep -inE "(ALTER TABLE|DROP TABLE|DROP FUNCTION|CREATE TRIGGER|ALTER FUNCTION|CREATE OR REPLACE FUNCTION|CREATE TABLE|CREATE (OR REPLACE )?VIEW|CREATE (UNIQUE )?INDEX|CREATE POLICY|GRANT|REVOKE)" | grep -v "public\.tops_"`. Every DDL statement in every file targets a `public.tops_*` name. The only non-`tops_` hits at all were four `DROP TABLE IF EXISTS tmp_*` lines — scratch temp tables created and dropped **within the same function body** as working state for a single computation (e.g. `tops_collections_movement`'s `tmp_movement`), never a persistent object.

**Verdict: PASS** (static, migration-source audit — every CREATE/DROP/GRANT/REVOKE targets a `tops_*` object or a same-function scratch temp table; zero `ALTER TABLE`, zero `DROP TABLE` on a real table, zero `CREATE OR REPLACE FUNCTION`/`GRANT`/`REVOKE` on anything but a `tops_*` function).

### 3. No trigger added to any existing table

Same grep above: `CREATE TRIGGER` appears **zero times** across all 18 migrations. Not "no trigger on an existing table" — no trigger was created at all, on anything, by this effort.

**Verdict: PASS.**

### 4. The calling engine is unchanged

No migration in this effort creates, replaces, or drops a `cc_*` function, table, or index (confirmed by the same DDL grep — zero `cc_` hits as a DDL target). The workspace's calling surface (`useCallingQueue.ts`, `useCallReveal.ts`, `useCloseCall.ts`) calls the existing `cc_call_queue_page`, `cc_state_counts`, `cc_reveal_phone`, `cc_record_unreached`, `cc_record_engaged` RPCs exactly as the existing Calling Hub does (confirmed by direct code comparison when those hooks were written, documented in their own file headers), and inserts into `cc_call_attempts` using the identical shape the current calling UI already uses. `pg_cron` shows no `cc_*`-named job touched (see item 6). The one place this effort's own `useCallingQueue.ts` deviates from purely reading the engine is re-sorting the ≤50 rows the engine's own RPC already selected and paginated, by a concept (bucket + money-at-risk) the engine has no way to know about — this reorders rows already on the page, never what the engine decided belongs on it, and is documented as a deliberate, retained design choice in `docs/TOPS_BUILD_LOG.md`'s 2026-09-28 entry rather than a silent gap.

**Verdict: PASS** (static: zero DDL against `cc_*`; the RPC call sites were built to mirror the existing calling UI's own calls, and the one behavioral deviation — an in-page re-sort — is confined to display order of an already-selected page, not the engine's own selection/pagination logic).

### 5. The collection write path is unchanged

`agent_allocate_tenant_payment` (the real collection write path) does not appear as a DDL target in any migration (same grep, zero hits). The workspace reads collections via `agent_collections` (a raw table, read-only per `docs/TOPS_RULES.md`) and maintains its own derived ledger (`tops_instalment_settlements`) through `tops_allocate_collection`/`tops_allocate_pending` — new, additive, `tops_`-prefixed functions that never write to `agent_collections`, `wallets`, or `general_ledger`. `scripts/guard-frontend-ledger-writes.mjs` (a pre-existing, unmodified guard) also ran clean throughout this effort's every task.

**Verdict: PASS.**

### 6. No existing cron job altered or disabled; cron jobs ADDED

`grep -c cron.unschedule` across all 18 migrations: **zero**. No existing job was ever touched. Live `pg_cron.job` query, filtered to `tops-%`, confirms exactly 7 jobs, all registered and active, matching the migration source exactly:

| Job name | Schedule | Command |
|---|---|---|
| `tops-build-plan-schedules-every-30min` | `*/30 * * * *` | `tops_build_schedules_batch(500)` |
| `tops-allocate-pending-collections-every-10min` | `*/10 * * * *` | `tops_allocate_pending(2000)` |
| `tops-refresh-work-items-hourly` | `0 * * * *` | `tops_refresh_work_items()` |
| `tops-agent-float-and-integrity` → `tops-snapshot-agent-float-adequacy-1800-eat` | `0 15 * * *` (18:00 EAT) | `tops_snapshot_agent_float_adequacy()` |
| `tops-resolve-promises-daily` | `0 23 * * *` | `tops_resolve_promises(NULL)` |
| `tops-refresh-restructure-register-hourly` | `0 * * * *` | `tops_refresh_restructure_register()` |
| `tops-detect-collection-anomalies-every-10min` | `*/10 * * * *` | `tops_detect_collection_anomalies(now() - interval '1 day')` |

Live count: 204 total `pg_cron` jobs project-wide, 195 active, 9 inactive — none of the 9 inactive ones share a `tops-` name or were touched by any migration in this effort (no `cron.unschedule` call exists to have done so).

**Verdict: PASS.**

### 7. Classic Tenant Ops renders and behaves identically

`git diff --stat` of `src/components/executive/tenant-ops/` (the directory `docs/TOPS_RULES.md` rule 8 marks read-only) across the whole window shows exactly one file touched: `AgentMonitoring.tsx` (44 insertions, 16 deletions). Traced to its own commit: `72064fb336...`, authored by **Benjamin Muhanguzi** (not this effort's author), titled "Agent Monitoring: stat cards show skeleton while loading, dash on error, never a false 0," whose own commit message states "UI only... No query, filter or data behaviour changed; no migration." This is an unrelated, independently-authored, concurrent UI fix by another contributor on this shared repo — not something the Tenant Ops Workspace effort made, caused, or is responsible for. This effort's own contribution to Classic is zero files, zero lines.

Not independently re-verified by clicking through Classic's own UI in this report (that would require a real authenticated browser session against this dev environment, which has an unrelated, already-documented session/auth quirk in this sandbox — see the Playwright-only browser note under item 8). The structural evidence is conclusive for this effort's own responsibility: Classic's route tree, its own lazy-loaded bundle, and every file under its protected directory (bar the one unrelated commit above) are byte-for-byte unchanged.

**Verdict: PASS** for this effort's responsibility, with the one unrelated concurrent change disclosed above (not a regression caused by this effort).

### 8. With the flag off, the new tab renders nothing and nothing else changes

**Run, not read** — a real Playwright browser test (`e2e/tenant-ops-workspace-flag-gate.spec.ts`, added as permanent regression coverage, not a throwaway check) drives a real Chromium instance against the real route with the real `TenantOpsWorkspacePage`/`WorkspaceShell` component tree, mocking only the Supabase network layer (auth session + `tops_is_workspace_enabled`'s return value):

- **Flag OFF**: navigates to `/tenant-ops/workspace?section=today`, asserts `"This page is not available."` is visible, and asserts the workspace's own tab bar (`role=tab`, "To call") and its "Today" heading do **not** exist anywhere on the page. **Passed** (17.1s).
- **Flag ON** (same route, same mocked session, only the flag differs): asserts the "not available" text does **not** appear, and the real shell (a "Calling" nav button) **is** visible. **Passed** (17.6s).

Live flag value, confirmed via direct query: `system_config.tops_workspace_enabled = false` in production right now — the flag this whole build has been toggled on only for the duration of each task's own browser verification and always reverted, consistent with `docs/TOPS_RULES.md`'s kill-switch requirement ("must never need a deploy or a revert" — flipping one `system_config` row is exactly that).

The gate itself (`TenantOpsWorkspacePage.tsx`) is fully self-contained: it does its own role check and its own flag read *before* rendering `WorkspaceShell`, and renders only a one-line "not available" `<div>` otherwise — there is no code path by which the flag being off could leave any partial workspace UI mounted, or affect any other route (the check runs inside this one lazy-loaded page component, not a global provider).

**Verdict: PASS**, verified by an actual browser run against the actual component tree, both flag states.

---

## CORRECTNESS

Every item below was tested by cloning a real `rent_requests` row via `jsonb_populate_record` (the same technique `supabase/tests/tops_plan_clock_and_instalments.sql` already established) inside `BEGIN; SET LOCAL session_replication_role = replica; ... ROLLBACK;` — self-contained, and independently confirmed to leave zero trace afterward (re-queried the exact synthetic figures post-rollback and found none).

### 9. A daily plan behind six days

Built a daily plan, `clock_start = as_at − 6`, nothing paid. `tops_plan_position_internal` returned:

```
periods_due = 6, days_behind = 6, days_past_due = 5, position_ugx = -60000, outstanding_ugx = 300000
```

`periods_due` matches exactly. The RPC has **two** separate, both-meaningful "behind" fields: `days_behind` (⌈deficit ÷ daily_repayment⌉ — "how many days of payment are you short") and `days_past_due` (as_at − the oldest unpaid instalment's own due date — "how old is the oldest thing you owe"). `days_behind` matches the expected "6" exactly. `days_past_due` is 5, not 6 — a real, structural fact of this schema, not a bug: instalments are due at `clock_start+1, +2, ...`, so for a fully-unpaid run of N consecutive daily instalments measured on the Nth one's own due date, the oldest is always `N−1` days before today (`days_past_due = periods_due − 1` in this configuration), by construction of `tops_build_plan_instalments`.

**Verdict: PASS** for the business-correctness claim (the plan is correctly identified as 6 periods / 6 days-of-payment behind) — flagging plainly that the acceptance brief's phrase "days_past_due 6" is satisfied by the RPC's `days_behind` field, not by its own same-sounding `days_past_due` field, which is a different, also-correct metric. Worth a one-line comment in the code or a rename if this ambiguity is likely to bite someone reading the two fields side by side later — not fixed here, since both fields are individually correct for what they define.

### 10. A weekly plan with two missed due dates

Built a weekly plan, two weekly instalments due (`clock_start+7`, `clock_start+14`), `as_at = clock_start+14`, nothing paid:

```
periods_due = 2, days_behind = 14, days_past_due = 7
```

Same pattern as item 9: `periods_due` matches "2" exactly; `days_behind` matches "14" exactly; `days_past_due` (7 — the age of the oldest unpaid instalment, due at `clock_start+7`) is a different, also-correct number under its own definition.

**Verdict: PASS**, same clarification as item 9.

### 11. A partial payment settles the oldest open instalment first

`tops_allocate_collection`'s own source is unambiguous (`ORDER BY due_date ASC, seq ASC`), and running it confirms it: built a 3×10,000 daily schedule, posted one 15,000 collection. Result: the oldest instalment settled **10,000** (fully), the second-oldest settled **5,000** (the remainder) — confirmed via `tops_instalment_settlements`, not inferred.

**Verdict: PASS.**

### 12. A reversed collection releases its settlements and is excluded everywhere

Same fixture: reversed the 15,000 collection (`agent_collections.reversed_at = now()`), re-ran `tops_allocate_collection` (the function checks `tops_is_collection_reversed()` and, when true, releases rather than allocates). Result: `released_count = 2` (both settlement rows released), `tops_instalment_settlements` shows **0** still-active rows for that collection, and re-querying `tops_plan_position_internal` immediately after shows `outstanding_ugx` back to the full **300,000** and `paid_to_date_ugx = 0` — the reversed payment no longer counts anywhere that reads settlements (every read in this codebase filters `released_at IS NULL`, confirmed in the security audit's function-by-function read).

**Verdict: PASS.**

### 13. A plan running ahead shows days of cover and no collection prompt

Built a plan 5 days into its term (expected 50,000), paid 100,000. `tops_plan_position_internal` returned `position_ugx = 50000` (positive), `days_ahead = 5`, `periods_due = 0`. The "no collection prompt" half of this claim is a UI assertion, already covered by a real component test (`PositionCard.test.tsx`, "renders Ahead... ahead of schedule — no collection prompt or chase action applies," passing) rather than re-verified here at the RPC layer, since the RPC itself has no concept of a "prompt" to check.

**Verdict: PASS**, RPC figures verified live; the no-prompt UI claim verified via the existing passing component test rather than re-run here.

### 14. Capped coverage is lower than uncapped; neither is clamped to 100%

Built one synthetic day (`2099-01-01`, guaranteed not to collide with real data) with two tenants each billed 10,000: tenant A paid 20,000 (overpayer), tenant B paid 0 (non-payer). `tops_collection_scoreboard` returned:

```
expected_ugx=20000, collected_on_schedule_ugx=10000 (capped), total_cash_in_ugx=20000 (uncapped)
capped_coverage_pct=50.0, uncapped_coverage_pct=100.0
```

50.0 < 100.0 — capped is lower, exactly as it should be. Neither individual tenant's contribution was force-clamped to make the *aggregate* hit 100%: the overpayer's own capped contribution correctly stopped at their own 10,000 bill (not their full 20,000, and not zeroed), which is what "not clamped to 100%" means in context — the cap applies per-tenant against that tenant's own bill, never as a global ceiling on the total.

**Verdict: PASS.**

### 15. Every schedule sums exactly to `total_repayment`

Live query across every real plan that currently has a resolved schedule:

```sql
SELECT count(*), count(*) FILTER (WHERE sched_sum = total_repayment)
FROM rent_requests JOIN (SELECT rent_request_id, SUM(amount_ugx) sched_sum FROM tops_plan_instalments GROUP BY 1) i ON ...
-- 3 plans checked, 3 matching, 0 mismatched
```

Only 3 real plans currently have a resolved cadence (the other ~600+ active plans are still `unknown`, an ongoing operational backlog already tracked in `docs/TOPS_BUILD_LOG.md`, not a defect of this check) — all 3 sum exactly. Reinforced by the "last instalment absorbs the remainder" design verified independently three separate times this build (the original `supabase/tests/tops_plan_clock_and_instalments.sql` fixtures, and again in items 9/11/12's own synthetic 300,000/90,000-total schedules above, all of which summed exactly).

**Verdict: PASS**, on all 3 real resolved schedules that currently exist, plus every synthetic schedule built for this report.

### 16. An unknown-cadence plan shows a notice, not a number

Ran `tops_plan_position_internal` against a real, live unknown-cadence plan: every numeric field (`position_ugx`, `periods_due`, `days_past_due`, `outstanding_ugx`, `catch_up_daily_ugx`) returned **NULL**. The UI side (the notice itself, and that no number renders) is directly covered by a passing component test: `PositionCard.test.tsx`, "shows the cannot-compute notice when cadence is unknown, with no figures."

**Verdict: PASS**, RPC-level NULLs confirmed live; UI notice confirmed by the existing passing test.

---

## OPERABILITY

### 17. Every new cron job is registered, active, and idempotent when run twice

Registration/active status: see item 6's table — all 7 confirmed live and active. Idempotency: ran every one of the 7 functions twice in direct succession and compared state before/after the second run:

| Function | Run 1 | Run 2 | Stable? |
|---|---|---|---|
| `tops_build_schedules_batch(500)` | 500 processed | 500 processed | `tops_plan_instalments` count unchanged (206→206) — yes |
| `tops_allocate_pending(2000)` | 2000 processed | 2000 processed | `tops_instalment_settlements` count unchanged (0→0) — yes |
| `tops_refresh_work_items()` | 3 | 3 | `tops_work_items` count unchanged (4→4) — yes |
| `tops_refresh_restructure_register()` | 0 | 0 | `tops_restructure_register` count unchanged (260→260) — yes |
| `tops_resolve_promises(NULL)` | 0 | 0 | no promises currently exist to resolve — idempotent trivially; a non-trivial run is exercised for real in item 19 below |
| `tops_snapshot_agent_float_adequacy()` | 97 upserted | 97 upserted | `tops_float_adequacy_snapshots` count for tomorrow unchanged (98→98) across both runs |
| `tops_detect_collection_anomalies(now() - interval '1 day')` | 0 new | 0 new | `tops_collection_anomalies` count unchanged (660→660) |

**Verdict: PASS**, all 7 confirmed idempotent by an actual double-run, not by reading the `ON CONFLICT`/upsert clauses and assuming.

### 18. Float adequacy for tomorrow is available the evening before

`tops_snapshot_agent_float_adequacy()`'s own source computes `v_for_date := (kampala today) + 1` explicitly — always tomorrow, never today. Confirmed live: running it today (Kampala date `2026-09-28`) wrote 97 rows with `for_date = 2026-09-29` (tomorrow), and a **separate**, pre-existing batch of 98 rows with `for_date = 2026-09-28` was already present from an earlier, real, automatic cron firing — direct evidence the mechanism has been working on its own schedule, not just when manually triggered for this report. The cron fires at `0 15 * * *` = 15:00 UTC = **18:00 EAT**, i.e. the evening before.

**Verdict: PASS.**

### 19. A promise past its date resolves automatically as kept, partial, or broken

Built three synthetic promises, all `promised_date` = 3 days ago, all still `status='open'`: one tenant paid the full amount inside the promise window (kept), one paid part of it (partial), one paid nothing (broken). Ran `tops_resolve_promises(today)`:

```
kept:    settled_amount_ugx = 20000 (full)     -> status = 'kept'
partial: settled_amount_ugx = 8000 (of 20000)  -> status = 'partial'
broken:  settled_amount_ugx = 0                -> status = 'broken'
```

All three resolved to exactly the expected outcome.

**Verdict: PASS.**

### 20. An escalation names a person and reaches them

Ran `tops_escalate_work_item` against a real, currently-open work item: calling it with a **NULL** target was rejected (exception raised — "names a person" is enforced, not optional). Calling it with a real target user succeeded: `tops_work_items.escalated_to` was set to that user, the note was recorded, and exactly **one** `tops_notifications` row was created for that same user, addressed to them specifically — the "reaches them" mechanism.

**Verdict: PASS.**

---

## Figure → RPC → basis inventory

A full read of every section and tenant/block file, tracing every displayed number back through its hook to its RPC. Format per figure: **label** — hook → RPC — has a `basis` field?

### Today
- Expected / Collected on schedule / Arrears collected / Total cash in / Coverage % (+ basis caption) — `useCollectionScoreboard` → `tops_collection_scoreboard` — **YES**
- Rolled into arrears, Promises broken, Plans completed (counts + amounts) — `useOvernightChanges` → `tops_overnight_changes` — no `basis` (has `as_at`)
- Funded-landlord-unpaid / Approved-unfunded / Agents-below-adequacy (counts) — `useBlockedItems` → `tops_blocked_items` — no `basis`
- Never billed (quarantined): count + arrears UGX — `useNeverBilledSummary` → `tops_never_billed_summary` — **YES**
- My work: count + value-at-risk per item — `useMyWorkItems` — **table read, not an RPC call** (see defects)

### Collections
- Due today (Billed/Paid/Unpaid/Coverage %, + per-row) — `useCollectionsDueToday` → `tops_collections_due_today` — no `basis`
- Arrears buckets (amount + count, + per-row age) — `useArrearsAgeing` → `tops_arrears_ageing` — no `basis`
- Movement (rolled-in/recovered/completed counts + amount) — `useCollectionsMovement` → `tops_collections_movement` — no `basis`, no `as_at`
- Never billed (per-row arrears) — `useNeverBilled` → `tops_never_billed` — no `basis`
- Anomalies count — `useCollectionAnomalies` → `tops_collection_anomalies_list`/`_count` — no `basis`
- Unknown cadence (count + total repayment) — `useUnknownCadencePlans` → `tops_unknown_cadence_plans` — no `basis`
- Work-item bucket badges (all tabs) — `useWorkItemsByRentRequestIds` — **table read, not an RPC call** (see defects)

### Calling
- Promise-kept rate % — `usePromiseKeptRate` → `tops_promise_kept_rate` — no `basis`
- State-tab counts — `useCallingStateCounts` → `cc_state_counts` — **not `tops_`-prefixed** (the calling engine's own RPC, called as-is per rule 7 — see below)
- Money at risk (per row) — `useCallingQueue` → `tops_calling_money_at_risk` (chained after the engine's own `cc_call_queue_page`) — no `basis`
- Attempts (per row) — `useCallingQueue` → `cc_call_queue_page` — **not `tops_`-prefixed** (engine's own field, rule 7)
- "Not in this round" (tenant count + total arrears) — `useCallingGapSummary` → **`tops_calling_gap_summary`** — YES `basis` — **fixed during this audit** (see Findings below; was a client-side `.reduce()` over `tops_calling_gap`'s rows until now)

### Pipeline
- Gap-tab counts — `usePipelineGapCounts` → `tops_pipeline_queue_gap_counts` — no `basis`
- Stalled-plan count, per-row age — `usePipelineQueue` → `tops_pipeline_queue` — no `basis`

### Places
- Plans / in-arrears / arrears rate % / money-at-risk per area — `useAreaBook` → `tops_area_book` — no `basis`
- Agent coverage plan counts — `useAgentAreaCoverage` → `tops_agent_area_coverage` — no `basis`
- Unmapped-tenants count — `useUnmappedTenantsWorklist` → `tops_unmapped_tenants_worklist` — no `basis`

### Agents
- Float balance / obligation / adequacy ratio / shortfall / tenants-at-risk — `useAgentFloatAdequacy` → `tops_agent_float_adequacy` — no `basis`
- Expected / collected / coverage % — `useAgentAttainment` → `tops_agent_attainment` — no `basis` (has `attribution_caveat` instead)
- Active plans / today % / effective % / tenants due / coverage today — `useAgentCapacityEligibility` → `tops_agent_capacity_eligibility` — no `basis`
- Arrears by bucket + total per agent — `useAgentArrearsBook` → `tops_agent_arrears_book` — no `basis`
- Reversed-collections count/UGX, corrections, churn — `useAgentIntegritySignals` → `tops_agent_integrity_signals` — no `basis`

### Weekly
- Active/paying tenants, payment rate %, dormant count — `useTenantOpsWeeklyPerformance`/`History` → `get_tenant_ops_weekly_performance`/`_history` — **not `tops_`-prefixed** (an earlier task's deliberate, documented reuse of the existing frozen weekly snapshot — see below)
- Total outstanding, PAR@7/14/30, by-funding-month cohorts — `usePortfolioQuality` → `tops_portfolio_quality` — **YES**

### Tenant360 (shared via TenantDrawer)
- Position/progress/catch-up figures — `usePlanPosition` → `tops_plan_position` — **YES**, also literally captioned in the UI
- PositionCard's "terms" (Total/Duration/Cadence rate) — reads `rent_requests` columns directly (documented in the hook as "static, non-computed", not derived) — not RPC-sourced
- Schedule ledger (amount due/settled/running arrears per row) — `usePlanScheduleLedger` → `tops_plan_schedule_ledger` + `_count` — no `basis`
- Pipeline-stage age — `usePlanPipelineStages` → `tops_plan_pipeline_stages` — no `basis`
- Tenant brief facts (outstanding, expected/paid-to-date, catch-up, missed instalments, last promise, contact history) — `useTenantBrief` → edge function `tops-tenant-brief` (via `functions.invoke`, not `.rpc()`) — **YES**, server-validates its own narrative against these facts
- Risk flags (idle days reuses `tops_plan_position`'s field — fine; duplicate/pause/reopen counts) — `useTenantRisk` — **table reads, not RPC calls** (see defects)
- Agent/proxy names, assignment history — `useAgentInfo` — names are table reads; history via `get_tenant_transfer_history` — **not `tops_`-prefixed**
- Place/GPS/address fields — `usePlaceInfo` — **table reads only, no RPC at all**
- Rent Access Limit (limit UGX, tier, progress %, deltas) — `useRentAccessLimitData` (table reads) feeding the **existing**, pre-dating-this-effort `RentAccessLimitActivity` component, which computes the limit **in the browser** via `calculateRentAccessLimit()` — see Findings below (considered exception, user-confirmed)
- Trust score, KYC level — `useTenantHeader` → `ops_tenant_behavior` (**not `tops_`-prefixed**) / direct `kyc_profiles` read
- Work-item value-at-risk (Actions row) — `useWorkItemForRentRequest` — **table read, not an RPC call**

### Findings from this inventory

**Fixed during this audit:** CallingSection.tsx was summing `tops_calling_gap()`'s already-fetched rows in the browser (`.reduce((sum, g) => sum + g.arrears_amount, 0)`) to show the "Not in this round" total — real client-side money arithmetic. Added `tops_calling_gap_summary()` (new migration `20260928110000_tops_calling_gap_summary.sql`, same `{count, total, basis}` shape as `tops_never_billed_summary`), a new `useCallingGapSummary()` hook, and switched the component to it. Verified live: returns `{tenant_count, total_arrears_ugx, basis}` correctly, has no `anon` grant, rejects a non-ops user. This is the only figure found that involved actual arithmetic on RPC data happening in the browser.

**Considered exception, left as-is — user-confirmed:** Tenant360's Rent Access Limit block. Its limit/tier/progress figures come from `calculateRentAccessLimit()`, a documented ("pure function, no DB writes, recomputed on the fly") pre-existing calculation in `src/lib/rentAccessLimit.ts`, reused via the pre-existing `RentAccessLimitActivity` component — neither written by this effort, both used elsewhere in the app already. No server-side RPC computing this same figure exists anywhere in the codebase to call instead. Asked the user directly whether to (a) leave and document, (b) remove from Tenant360 only, or (c) port the formula into a new `tops_` RPC (creating a second copy of the formula that could drift from the original). **User chose (a): leave it, documented here as a considered exception** — duplicating an already-audited, shared calculation into a parallel copy carries real drift risk that outweighs the rule technicality for a figure this effort didn't introduce and doesn't own.

**Intentional, not a defect — required by rule 7:** the Calling tab's state-tab counts and per-row "Attempts" come from the existing calling engine's own `cc_state_counts`/`cc_call_queue_page` RPCs. `docs/TOPS_RULES.md` rule 7 requires reading the calling engine's own objects unchanged — of course its own counts aren't `tops_`-prefixed; they belong to the engine, not to this workspace.

**Intentional, not a defect — already decided in an earlier task:** the Weekly tab's four headline figures reuse the existing, frozen `get_tenant_ops_weekly_performance`/`_history` RPCs rather than a new `tops_` equivalent — `WeeklySection.tsx`'s own comment documents this as a deliberate decision to keep one canonical weekly snapshot rather than fork a second one that could show a different number for the same week.

**Recorded recommendation, not acted on this task — scope too large for this session:** roughly ten more figure sources trace to a direct table read rather than a named RPC, but **none of them perform arithmetic in the browser** — they display an already-computed or genuinely static value as-is (My Work / Actions-row / Calling-badge reads of `tops_work_items`; PositionCard's static `rent_requests` terms; `useTenantRisk`'s raw counts; `useTenantHeader`'s trust score via the non-`tops_`-prefixed `ops_tenant_behavior`; `useAgentInfo`'s `get_tenant_transfer_history`; `usePlaceInfo`'s GPS/address reads with no RPC at all). These fail the *letter* of "every figure comes from a tops_ RPC" without failing its *spirit* (no client-side derivation). Wrapping all of them in thin, additive `tops_` RPCs is real, well-scoped, low-risk follow-up work — flagged as a background suggestion rather than rushed through at the end of an already very large session.

---

## Summary

| # | Item | Verdict |
|---|---|---|
| 1 | Exactly two files, one route + one nav entry | PASS (2 disclosed, out-of-scope findings) |
| 2 | No existing DB object altered; migrations CREATE-only on `tops_*` | PASS |
| 3 | No trigger added to any existing table | PASS |
| 4 | Calling engine unchanged | PASS |
| 5 | Collection write path unchanged | PASS |
| 6 | No existing cron altered/disabled; 7 added | PASS |
| 7 | Classic renders/behaves identically | PASS (1 disclosed, unrelated finding) |
| 8 | Flag off → renders nothing, nothing else changes | PASS |
| 9 | Daily plan behind six days | PASS (field-naming clarification) |
| 10 | Weekly plan, two missed due dates | PASS (field-naming clarification) |
| 11 | Partial payment settles oldest first | PASS |
| 12 | Reversed collection releases settlements | PASS |
| 13 | Ahead plan shows days of cover, no prompt | PASS |
| 14 | Capped coverage < uncapped, neither clamped | PASS |
| 15 | Every schedule sums to total_repayment | PASS |
| 16 | Unknown-cadence plan shows notice not a number | PASS |
| 17 | Cron jobs registered, active, idempotent | PASS |
| 18 | Float adequacy available evening before | PASS |
| 19 | Promise resolves kept/partial/broken | PASS |
| 20 | Escalation names and reaches a person | PASS |
| — | Figure → RPC → basis inventory | 1 real defect found and fixed live (`tops_calling_gap_summary`); 1 considered exception (Rent Access Limit, user-confirmed); 2 intentional non-defects (calling engine counts, frozen weekly RPC); ~10 lower-severity items (table reads, no browser arithmetic) recorded as follow-up, not fixed this task |

**20 of 20 PASS.** Two items (9, 10) carry an important field-naming clarification, not a defect: the RPC's `days_behind` field is what the acceptance brief's phrasing describes; its `days_past_due` field is a different, separately-correct metric (age of the oldest unpaid instalment) that happens to sound similar. Two non-regression items (1, 7) disclose real, verified findings about unrelated concurrent work touching the same shared files/directories — neither caused by, nor a defect of, this effort. The figure inventory (run at the end, over and above the 20 numbered items) found exactly one real defect — client-side money arithmetic in the Calling tab — fixed live during this report; every other gap found is either an intentional, rule-required or already-decided design choice, or a lower-severity naming-only gap with no arithmetic in the browser, recorded for follow-up rather than rushed through here.
