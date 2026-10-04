# Requisitions not reaching the CFO after COO approval

## What I found

The COO → CFO handover in the database is working. SRQ-00030 moved supervisor → COO → CFO this morning, `stage` is `cfo`, `current_approver_role` is `cfo`, and all three CFO-role holders (including Angwen Sarah) received an in-app notification at 09:13. Nothing is stuck in transit.

Two real problems explain what you are seeing.

### 1. Ten requisitions never route to the CFO by design

`staff_requisition_route` checks the requester's roles. If the requester holds the `cfo` role, the route becomes COO → **CEO** and the CFO stage is skipped entirely (`final_stage = 'ceo'`), so that nobody approves their own money.

JOSHUA WANDA holds `cfo` alongside `cto`, `manager` and `access_admin`. Every requisition he raises therefore goes COO → CEO. That is 10 of the 33 requisitions on file, including SRQ-00031 and SRQ-00032 today, both approved by the COO and then finished by the CEO. From the CFO dashboard they look like requisitions that vanished after COO approval.

### 2. The CFO approval bell does not watch this queue at all

`src/hooks/useCfoApprovalNotifications.ts` has entries for `director_requisitions` and `employee_requisitions` — both retired flows — and **no entry for `staff_requisitions`**. So a requisition sitting at the CFO stage raises no count, no bell badge, and no link into the requisitions section. The CFO only ever finds it by opening that section manually.

The legacy `employee_requisitions` queue the bell does watch holds exactly one pending row, from 14 August, and its submit function returns 410, so that counter is permanently near zero and misleading.

## Proposed fixes

**A. Surface staff requisitions in the CFO bell**

Add a `staffRequisitions` definition to `useCfoApprovalNotifications` counting `staff_requisitions` where `stage = 'cfo'`, pointing at the existing `requisitions` tab, and drop or clearly mark the two retired counters. Nothing about the existing 13 queues changes.

**B. Decide what the CFO-role skip should mean**

This is a business decision, not a bug fix, so I want your call before touching it:

- Keep it as is — a person holding the CFO role can never have their own requisition reviewed by the CFO office, and the CEO is the backstop.
- Or narrow it, so the skip applies only when the requester is *the* acting CFO rather than anyone who happens to carry the role. JOSHUA WANDA's primary function is CTO; under this option his requisitions would route COO → CFO like everyone else.

Either way, the CFO queue should show a visible line for requisitions that bypassed the CFO stage, so nothing appears to disappear silently.

**C. Make the routing visible on the card**

Show the remaining path on each requisition card ("COO, then CEO" / "COO, then CFO") so an approver can tell at a glance where a request is headed and why it may never arrive.

## Technical notes

- Database objects involved: `staff_requisitions`, `staff_requisition_events`, `staff_requisition_department_routes`, function `staff_requisition_route(_user_id)`.
- Edge function `staff-requisition-decide` advances the stage with `nextStage = stageKey === 'supervisor' ? 'coo' : row.final_stage`, so the COO always hands to whatever `final_stage` was stamped at submission. The skip is decided at submission time, not at approval time — that is why re-approving cannot recover it.
- `notifications` inserts are fine: `block_all_notification_inserts` already allowlists the `staff_requisition` type, and 337 such rows exist.
- Option A is frontend only. Option B needs a migration to `staff_requisition_route` plus a decision on whether the 10 existing `final_stage = 'ceo'` rows are left alone (recommended — they are already approved and credited).
