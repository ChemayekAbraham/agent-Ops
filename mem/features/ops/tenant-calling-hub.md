---
name: Tenant Calling Hub
description: Tenant Ops → Classic → Tenant Ops Tools → Calling Hub; three-status append-only call workflow (pending/closed/missed) over v_tenant_daily_eligibility with CSV reports
type: feature
---
Location: `?tab=tenant-ops&mode=classic&view=calling-hub` (shell-only view in `TenantOpsClassicShell`, nav entry in `tenantOpsNav.ts`).

Data: population + money from `v_tenant_daily_eligibility` (one row per tenant, newest plan wins) joined to `profiles`; call state from `v_tenant_call_summary`.

Call model (append-only, never updated): `tenant_call_reports` now has `status` (`pending|closed|missed`, default `pending`) and `follow_up_at`. Legacy `outcome` is still written (`missed`→missed, else `picked_up`) because `MissedDaysTracker` reads it. A tenant's current status = status of newest record. Summary view adds `last_status`, `pending_count`, `closed_count`, `last_follow_up_at`.

"To call" bucket = never called OR newest status pending/missed and (follow_up_at passed, or last call older than the 3/7/14-day re-call window). Closed tenants leave the list.

Files: `src/hooks/useTenantCallingList.ts`, `src/hooks/useTenantCallReports.ts`, `tenant-ops/TenantCallingHub.tsx`, `TenantCallDrawer.tsx`, `TenantCallReportsPanel.tsx` (date-picker + `downloadCsv` exports: all/pending/closed/missed/per-staff/comments, each row carrying full tenant + call fields).
