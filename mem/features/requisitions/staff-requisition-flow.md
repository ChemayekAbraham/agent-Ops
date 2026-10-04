---
name: Staff Requisition Flow
description: Unified staff funding requisitions raised in My Space, routed department head -> COO -> CFO with auto wallet credit; replaces director and employee requisition flows
type: feature
---
# Staff Requisition Flow (2026-08-22)

Single funding-request flow for every staff member. Replaces the retired
`director_requisitions` and public-link `employee_requisitions` flows.
Merchant float requisitions are unchanged.

## Route
My Space > "Make a requisition" (`/me/requisitions`) →
department head (per `staff_requisition_department_routes`) → COO → CFO.
Final CFO approval auto-credits the requester's wallet through the shared
`_shared/requisitionWalletCredit.ts` engine.

Self-approval is skipped: a department head starts at COO, the COO starts at
CFO, and a CFO request ends with CEO as `final_stage`.

## Data
- `staff_requisitions` — stage (`supervisor|coo|cfo|ceo|approved|rejected|returned`),
  `current_approver_role`, `final_stage`, `approved_amount`, per-stage notes,
  `wallet_credit_status`.
- `staff_requisition_events` — append-only audit trail.
- `staff_requisition_department_routes` — department key → approver role.
- `staff_requisition_route(_user_id)` — returns the routing for a user (note the
  `_user_id` parameter name).
- `v_staff_requisition_budget_context` — department budget vs committed; over-budget
  is a **warning only**, never a block.

## Edge functions
- `staff-requisition-submit` (new + resubmit of returned rows)
- `staff-requisition-decide` (`approve` | `reject` | `return_info`; 10+ char comment
  required for reject/return; approver may edit the amount)
- `requisition-credit-retry` supports `source_table: 'staff_requisitions'`
- `requisition-submit` and `create-director-requisition` return **410 Gone**

## UI
- `src/pages/me/Requisitions.tsx` — requester view.
- `src/components/requisitions/StaffRequisitionQueue.tsx` — shared reviewer queue
  ("Awaiting my review" derived from roles vs `current_approver_role`).
- `src/components/requisitions/RequisitionsWorkspace.tsx` — mounted on the
  `requisitions` tab of CEO/COO/CFO/CTO/CMO/CRM/HR dashboards; wraps the queue plus
  collapsed read-only legacy director history (`DirectorRequisitionsPanel readOnly`).
