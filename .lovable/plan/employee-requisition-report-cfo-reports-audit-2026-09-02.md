# Employee Requisition Report (CFO → Reports & Audit)

A new read-only report that lists every employee/staff requisition the CFO has approved, keyed on the actual CFO approval timestamp.

## What the CFO gets

A new sidebar item **Employee Requisition Report** under Reports & Audit, showing:

- **Period tabs**: Daily, Weekly, Monthly, Quarterly, Yearly. Picking a period sets the window (today, this week, this month, this quarter, this year) and groups the summary rows by that bucket.
- **Custom date range**: from/to override for any window.
- **Department filter**: single-select of the departments present in the data, plus "All departments".
- **KPI line**: number of approved requisitions, total approved amount (UGX), average amount, number of distinct staff.
- **Grouped summary**: one row per period bucket (e.g. per day / per ISO week / per month / per quarter / per year) with count and total approved.
- **Detail table**: requisition code, requester, department, title/purpose, requested amount, approved amount, CFO approval date & time, CFO note, wallet credit status.
- **CSV export** of the filtered detail rows (same columns), matching how the other CFO reports export.

## Source of truth (verified against the live database)

- Live flow table `staff_requisitions` carries `cfo_decided_at` / `cfo_decided_by` — this is the approval date/time the report filters and buckets on. 27 rows currently have a CFO decision (2026-08-24 → today). Rows approved with CEO as the final stage (6 rows, no CFO decision) are correctly excluded.
- Department comes from `department_key`; 6 distinct values are present today.
- Amount shown is `approved_amount` when set, otherwise `amount` (the CFO may edit the amount at approval).
- Retired public-link flow `employee_requisitions` has its own `approved_at` / `approved_by` / `department` and 8 approved historical rows. These appear under a **Legacy (public link)** toggle, off by default, so historical requests remain traceable without mixing flows.

## Technical notes

- New component `src/components/cfo/EmployeeRequisitionReportPanel.tsx`, following the structure of `MerchantFloatRequisitionReportPanel.tsx` / `ExpenseReportPanel.tsx` (Card layout, period toggle, react-query fetch, CSV via existing helper).
- Data fetched client-side through the Supabase client with server-side filters: `.not('cfo_decided_at','is',null)`, `.gte/.lte('cfo_decided_at', ...)`, optional `.eq('department_key', ...)`, ordered by `cfo_decided_at` desc. No new RPC or migration needed — existing CFO read policies already cover these tables.
- Wire-up: sidebar entry `{ label: 'Employee Requisition Report', id: 'employee-requisition-report' }` in `executiveSidebarConfig.ts` (CFO Reports & Audit group, next to Merchant Requisition Report) and a matching `case` in `src/pages/cfo/Dashboard.tsx`.
- Read-only: no writes, no approval actions, no changes to the requisition flow itself.
