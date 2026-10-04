---
name: Director Requisition Approval Workflow
description: Staff submit funding requisitions to the Director (CEO role) with in-app + SMS + email alerts, approve/reject/request-info, full audit trail
type: feature
---
# Director Requisition Approval Workflow

Operational funding requests routed to the Director for approval.

## Data
- `director_requisitions`: requisition_code (auto `REQ-00001` via `director_requisition_seq`), title, amount, reason, status (`pending`|`approved`|`rejected`|`more_info`), requester_id/name/role, approver_id/name, director_comment, decided_at.
- `director_requisition_events`: append-only audit trail (`created`,`approved`,`rejected`,`more_info_requested`,`comment`,`resubmitted`) with actor + comment.
- Helper `is_welile_staff(uid)` = any of ceo/cfo/coo/cto/cmo/crm/hr/manager/super_admin/operations/employee.
- RLS: staff SELECT all; staff INSERT own requisitions. All mutations otherwise via service-role edge functions. Realtime enabled on `director_requisitions`.

## Notifications
- In-app: `notifications` type = `director_requisition` (allowlisted in `block_all_notification_inserts` trigger alongside `merchandise_recovery`).
- SMS via shared `sendSmsMultiProvider.sendSMS`.
- Email via `send-transactional-email` templates `director-requisition-new` (to Director) and `director-requisition-status` (to requester).
- Director = users with `ceo` role (no dedicated director role yet). Review URL: `https://welileapp.com/director/dashboard`.

## Edge functions
- `create-director-requisition`: staff-only; inserts requisition + `created` event + audit_log; notifies every CEO-role director (in-app + SMS + email).
- `director-requisition-action`: director-only (ceo/super_admin/manager); body `{requisition_id, action: approve|reject|request_info, comment(min10)}`; updates status, logs event + audit_log, notifies requester. approve/reject are terminal (409 if already final).

## UI
- Dedicated **Director Dashboard** at `/director/dashboard` (`src/pages/director/Dashboard.tsx`, route-guarded to ceo/super_admin/manager): master–detail — 4 tabs (Pending/More Info/Approved/Rejected) list → click a card to open the requisition detail view with full metadata, audit trail, and approve/reject/request-info actions. Realtime refresh. Linked as a prominent card at the top of `/admin/dashboard` (visible to ceo/manager/super_admin). Email/SMS review URLs point here.
- `src/components/requisitions/DirectorRequisitionsPanel.tsx`: tabbed list + create dialog (prefilled sample "Merchant Line Top-up Request" / UGX 8,000,000) + inline audit trail; used by CEO dashboard (`requisitions` tab) and CFO dashboard (Quick Actions → Requisitions) so staff can raise requests.
