# Tenant Calling Hub — study and recommended approach

## What already exists (reuse, don't rebuild)

**Call tracking is already live.**
- Table `tenant_call_reports` (append-only): `id, tenant_id, rent_request_id, outcome ('picked_up' | 'missed'), comment, called_by, called_at, created_at`.
- View `v_tenant_call_summary`: per-tenant rollup — `call_count, picked_up_count, missed_count, last_call_at, last_picked_up_at, last_outcome, latest_comment, latest_comment_at`.
- Hooks `useTenantCallSummaries`, `useTenantCallHistory`, `useLogTenantCall` (`src/hooks/useTenantCallReports.ts`).
- `LogTenantCallDialog` already records outcome + optional comment and shows the full history.
- `MissedDaysTracker` already has an early version of this idea: a "To call / Called" tab pair, a "call again after N days" selector, and per-row Log-call buttons — but it is scoped to missed-days only, not a complete tenant list.

**Tenant data source.** `v_tenant_daily_eligibility` is the authoritative active-plan population and already carries `tenant_id, agent_id, landlord_id, rent_request_id, daily_repayment, rent_amount, amount_repaid, total_repayment, start_at, status, tenant_no_smartphone`. Owed = `total_repayment - amount_repaid`; missed days are derived exactly as `MissedDaysTracker` does (anchor `start_at`). Names/phones/location come from `profiles` (batched `.in()` pattern already used).

**Shell and UI patterns.** Tenant Ops → Classic runs on the persistent sidebar shell (`tenantOpsNav.ts`, `TenantOpsSidebar`, `TenantOpsClassicShell`), URL-synced by `view`. Reusable pieces: `KPICard`, `ContactActions` (Call / WhatsApp / SMS), `UserProfileSheet` / `UserDrilldownDrawer`, `TenantOpsFilterBar`, `TenantOpsReportToolbar`, `Calendar`-in-`Popover` date pickers (see `TenantBalanceEditPanel`), `downloadCsv` (`src/lib/csvExport.ts`), `exportToCSV`/`exportToPDF` (`src/lib/exportUtils.ts`), and `TenantOpsExtractCenter` as the reports index.

## Recommended solution

### 1. Location and navigation
Add one child under **Tenant Ops Tools**: `Calling Hub` (view key `calling-hub`), plus one entry in Reports & Tools → Reports Hub index pointing at it. Because the shell already syncs `?view=`, direct links, refresh and back/forward work with no routing changes. New component: `src/components/executive/tenant-ops/TenantCallingHub.tsx`, mounted as a shell-only view (like `phone-duplicates`), so `TenantOpsDashboard` is untouched.

### 2. Page structure
- KPI strip (`KPICard`): To call, Pending, Closed, Missed, Calls logged today.
- Tabs: **To call** · **Pending** · **Closed** · **Missed** · **All calls**.
- Filters row (reuse `TenantOpsFilterBar` styling): search (name/phone), agent, district, owed-amount / missed-days sort, and a "call again after N days" selector (3/7/14, same as MissedDaysTracker).
- Table/list rows: tenant name, phone with `ContactActions`, agent, owed, daily payment, missed days, last call + status badge, and a "Log call" button. Same responsive card-on-mobile pattern used elsewhere.
- Row click opens a **drawer** (Sheet), not a new page.

### 3. Tenant drawer — what to show (deliberately compact)
Four small blocks, all from data already fetched:
1. **Identity**: name, phone (Call/WhatsApp/SMS), national ID, location (district/ward), plan status.
2. **Money**: rent amount, expected daily payment, repaid, **amount owed**, missed days, days since start, repayment %.
3. **Network**: agent (name + phone), landlord (name + phone), house/listing reference.
4. **Call history**: full append-only list (date/time, status, staff, comment) + the log-call form.

### 4. Call workflow (three statuses)
Extend the existing append-only model rather than replacing it. Each logged call carries a status:
- **Pending** — reached/attempted, follow-up still expected (optionally with a follow-up date).
- **Closed** — matter resolved, no further call needed.
- **Missed** — did not reach the tenant.

Optional comment on every record. **The tenant's current status = status of their newest call record**; history is never mutated. A tenant leaves the "To call" list as soon as any call exists and appears under its status tab; it returns to "To call" when the newest record is Missed/Pending and older than the chosen re-call window (or the follow-up date has passed). Nothing about rent, eligibility or tenant logic changes.

### 5. Data approach
Additive migration only:
- Add `status text` to `tenant_call_reports` (values `pending|closed|missed`), plus optional `follow_up_at timestamptz`. Backfill existing rows: `picked_up → pending`, `missed → missed`. Keep `outcome` as-is for backward compatibility with `MissedDaysTracker`.
- Extend `v_tenant_call_summary` with `last_status`, `pending_count`, `closed_count`, `last_follow_up_at` (view replace; existing columns preserved).
- GRANTs and RLS follow the existing table's ops-staff policy — no new permission model.
No new tables, no writes to `rent_requests` or wallets.

### 6. Reporting and export
Add a **Calling Reports** card inside the hub (and link it from `TenantOpsExtractCenter`):
- From/To date pickers (`Calendar` in `Popover`, existing pattern) + status filter + agent filter.
- Exports via existing helpers: CSV through `downloadCsv`, branded PDF through the existing report/PDF pattern.
- Report sets: All calls, Pending, Closed, Missed, Calls made (per staff member), Status summary, Comments log.
- Every row exports both call fields (date/time, status, comment, logged-by) and tenant fields (name, phone, agent, landlord, rent, daily payment, owed, missed days, location).

### 7. Edge cases and conflicts to respect
- `MissedDaysTracker` reads `outcome` — keep that column populated so it keeps working.
- Tenants with no phone: show disabled contact actions; still loggable as Missed.
- Duplicate-phone tenants (`TenantPhoneDuplicatePanel`) can appear twice — dedupe by `tenant_id`.
- Multiple plans per tenant: group by tenant, store `rent_request_id` on the call for traceability.
- Inactive / `not_paying` tenants are excluded from `v_tenant_daily_eligibility` and will silently drop off the list — make that explicit with a small note.
- Large populations: keep the existing 1000-row paginated fetch loop; do all filtering client-side as the other panels do.
- Timezone: display in Kampala time; store UTC.

### 8. Files to add or touch
Add: `TenantCallingHub.tsx`, `TenantCallDrawer.tsx`, `TenantCallReportsPanel.tsx`.
Change (minimal): `tenantOpsNav.ts` (one nav child), `TenantOpsClassicShell.tsx` (mount the view), `useTenantCallReports.ts` (status + follow-up fields, date-ranged report query), `LogTenantCallDialog.tsx` (three-status selector), `TenantOpsExtractCenter.tsx` (one report entry), plus one additive migration.
