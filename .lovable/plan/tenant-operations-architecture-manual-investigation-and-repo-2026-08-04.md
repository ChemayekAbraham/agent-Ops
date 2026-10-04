# Tenant Operations Architecture Manual — investigation and report plan

Deliverable: one new file, `docs/TENANT_OPERATIONS_ARCHITECTURE.md`, covering all 20 requested sections. Read-only exercise: no code, SQL, migrations, Edge Functions, triggers, configuration, or data will be changed.

## What initial scoping already confirmed

- Tenant Ops UI lives under `src/components/executive/` — `TenantOpsHub.tsx`, `TenantOpsDashboard.tsx`, `TenantOpsDashboardV2.tsx` (three coexisting dashboard surfaces), `TenantOpsLandlordFloatPanel.tsx`, `TenantOpsLandlordFloatTimeline.tsx`, plus 11 files in `src/components/executive/tenant-ops/`.
- Supporting layers: `src/hooks/useTenantOpsAnalytics.ts`, `src/lib/tenantOpsFilters.ts`, `tenantOpsPresets.ts`, `generateTenantOpsReportPdf.ts`, `generateTenantOpsExtractPdf.ts`, and `src/components/ops/*` (UserDrilldownDrawer, RentHistoryVerificationQueue, TenantOpsSearch, BusinessAdvanceQueue).
- COO reporting surface: `src/pages/coo/reports/TenantOpsReport.tsx`, routed at `/coo/reports/tenant-ops` behind `RoleGuard` for `coo, super_admin, cto, manager`.
- ~29 candidate tenant/rent Edge Functions, including `register-tenant`, `submit-tenant-form`, `approve-rent-request`, `fund-tenants`, `fund-tenant-from-pool`, `disburse-rent-to-landlord`, `manual-collect-rent`, `submit-offline-collection`, `tenant-pay-rent`, `transfer-tenant`, `replace-tenant`, `delete-rent-request`, `apply-rent-overdue-penalty`, `rent-reminders`, `refresh-tenant-idle-states`, `notify-tenant-inactive`.

## Investigation approach

1. **Parallel sub-agents** for the four heavy read surfaces: (a) UI, dashboard and reporting surface; (b) the ~29 tenant/rent Edge Functions; (c) the rent-request and collection RPC family; (d) triggers and workflow guards on tenant-facing tables.
2. **Database introspection**, read-only queries only: `rent_requests`, tenant/profile tables, `house_listings`, `agent_collections`, `field_collections`, rent payment tables, `welile_homes_*`, business advances; plus `pg_policies`, `pg_trigger`, `pg_proc` bodies and grants, `cron.job`, and live status/row counts.
3. **Verify before asserting.** Every current-state claim (a status value, a row count, a missing policy, a guard's behaviour) is tagged **[observed]** only when a query or file read in this investigation confirms it; anything deduced is tagged **[inferred]**. Anything not covered gets an explicit gap note rather than a confident guess.
4. **Cross-reference** the existing manuals rather than restating them: `docs/FINANCIAL_SYSTEM_ARCHITECTURE.md`, `docs/FINANCIAL_OPERATIONS_ARCHITECTURE.md`, `docs/AGENT_SYSTEM_ARCHITECTURE.md`, `docs/SUPPORTER_SYSTEM_ARCHITECTURE.md`, and the CFO manual.

## Report structure

All 20 sections as specified, in order: Executive Summary; Complete Tenant Lifecycle (stage by stage with business rules, validations, database writes, notifications, audit trail); Tenant Business Model; Rent Request Engine; Tenant Management; Database Table Inventory (each classified source-of-truth / projection / cache / audit / configuration / legacy / deprecated); Edge Function Inventory; RPC Inventory; Trigger Inventory; Rent Collection Engine; Tenant Financial Interaction; Workflow State Machines; Dashboard Architecture; Reporting Engine; Security Model; Failure Modes; Cron Jobs; 13 end-to-end Mermaid diagrams; Risk Assessment with a ranked gap register; Appendices (dependency graphs, state diagrams, permission matrix, financial interaction matrix, business rule catalogue, glossary).

A short "Read this first" block at the top will list the highest-severity verified findings, matching the format of the existing manuals.

## Technical notes

- Style and evidence conventions follow `docs/FINANCIAL_OPERATIONS_ARCHITECTURE.md`: observed/inferred tags, tables over prose, file and function names cited inline, Mermaid for diagrams.
- Focus areas carried over from earlier investigations that this report will **verify rather than assume**: the `guard_rent_request_agent_updates` transition whitelist, `agent_collections` as the sole source for daily capacity, the `not_paying` inactivation and house-release path, outstanding-balance and amount-repaid drift, and the role of `v_agent_daily_eligibility` in tenant funding state.
- Expected length is comparable to the existing manuals (roughly 400-600 lines) given the section count.