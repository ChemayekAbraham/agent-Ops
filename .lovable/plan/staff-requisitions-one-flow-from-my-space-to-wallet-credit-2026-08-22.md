# Staff Requisitions: one flow from My Space to wallet credit

Today there are two separate money-request flows. Director requisitions are raised inside executive dashboards and decided by the CEO alone. Employee requisitions arrive through a public no-login link and are decided by the CFO alone. Both credit the requester's wallet on approval using the same shared credit engine. Merchant float requisitions stay exactly as they are.

This replaces both with a single staff requisition that starts in My Space and moves through three approvals.

## The new flow

```text
Staff member (My Space -> "Make a requisition")
        |
        v
Department head dashboard   (CTO / CMO / CFO / HR / Ops lead ... by department)
        |  approve
        v
COO dashboard               (second review)
        |  approve
        v
CFO dashboard               (final review + release)
        |  approve
        v
Requester's wallet auto-credited
```

- Any staff member with a My Space section can raise one.
- Reject at any stage ends it, with a mandatory reason (10+ characters).
- "Send back for more info" at any stage returns it to the requester, who can edit and resubmit; it re-enters at the stage that sent it back.
- If the requester is themselves a department head (CTO, CMO, HR, etc.), the request skips the supervisor stage and starts at the COO.
- If the COO raises one it starts at the CFO. A CFO's own request needs COO approval and then CEO sign-off, so nobody approves their own money.

## Supervisor routing (by department)

The requester's active HR department decides the first approver:

| Department | First approver |
| --- | --- |
| Engineering & Product, Product R&D | CTO |
| Marketing | CMO |
| Finance | CFO |
| Operations | COO (starts at COO stage) |
| Tenant Ops, Agent Ops, Landlord Ops, Partner Ops | matching ops dashboard lead |
| Partnership | CRM |
| Interns, Support and Welfare | HR |
| Board of Directors | CEO |

Staff with no active department cannot submit until HR assigns one; the form says so plainly.

## Department budget: warning, not a block

Each stage shows the department's approved budget for the current period, how much has already been committed through requisitions, and what would remain if this one is approved. Over-budget requests show a clear warning banner at every stage but can still be approved. Nothing is blocked automatically.

## My Space

New card "Make a requisition" next to the existing cards. It opens a page listing the person's own requisitions with live status (which stage it is at, who has it, comments received) plus a "New requisition" form: title, amount, category, reason, when needed by, optional attachments. Requesters can edit and resubmit anything sent back to them.

## Technical details

**Database (one migration)**

- New table `public.staff_requisitions`: `requisition_code` (`SRQ-00001` via sequence), requester id/name/department_id, title, amount, category, reason, needed_by, attachment_urls, `stage` (`supervisor` | `coo` | `cfo` | `ceo` | `approved` | `rejected` | `returned`), `current_approver_role`, per-stage decision columns (by / at / note / approved_amount) for supervisor, COO and CFO, plus `wallet_credit_status`, `wallet_transaction_id`, `credited_at`, `credited_by`, timestamps + update trigger. GRANTs to `authenticated` and `service_role`; RLS: requester reads/updates own while `returned`, staff read all, all state changes only through service-role edge functions.
- New table `public.staff_requisition_events`: append-only audit trail (created, approved, rejected, returned, resubmitted, credited) with actor and comment.
- `public.staff_requisition_department_routes`: department_id -> approver role, seeded from the table above so routing is data-driven, not hard-coded.
- Function `staff_requisition_route(user_id)` returns the first stage and approver role, applying the self-approval skips.
- View `v_staff_requisition_budget_context`: per department, approved budget total for the open cycle, committed requisition total, remaining. Used for the warning banner (single query, no N+1).
- Both legacy tables are kept read-only for history: revoke insert, and `requisition-submit` / `create-director-requisition` return 410. No data is migrated.

**Edge functions**

- `staff-requisition-submit`: authenticated staff only; resolves department and route, inserts requisition + `created` event + audit log, notifies the target approver role in-app, by SMS and by email.
- `staff-requisition-decide`: body `{requisition_id, action: approve|reject|return_info, comment, amount?}`; verifies the caller holds the role that currently owns the stage; advances supervisor -> coo -> cfo, or terminates; on the final CFO approval calls the existing `_shared/requisitionWalletCredit.ts` with `sourceTable: 'staff_requisitions'` so the wallet credit stays idempotent and ledger-backed, rolling the approval back if the credit fails (same pattern as `requisition-decide`).
- `requisition-credit-retry` gains `staff_requisitions` as an allowed source table.
- Emits `system_events` on submit, each decision, and credit.

**Frontend**

- `src/pages/me/Requisitions.tsx` + card in `src/pages/me/PersonalHub.tsx`.
- `src/components/requisitions/StaffRequisitionQueue.tsx`: one shared review queue (pending / returned / approved / rejected tabs, detail view, audit trail, budget banner, approve / reject / return actions), rendered on the CTO, CMO, CFO, CRM, HR, ops and CEO dashboards filtered to the stage that role owns, and on the COO dashboard for the COO stage.
- `DirectorRequisitionsPanel` and `PublicRequisitionForm` switch to read-only history; their "create" affordances are removed.
- Realtime subscription on `staff_requisitions` so queues refresh without polling.
