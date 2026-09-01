# Why COO-approved staff requisitions never reach the CFO

## What I confirmed

The approval pipeline itself is working. `SRQ-00030` (Abraham Chemayek) was approved by the department head and the COO and is sitting correctly at `stage = cfo`, `current_approver_role = cfo`, waiting for a CFO decision. Read access is fine too: all three CFO-role users (Angwen Sarah, Joshua Wanda, Benjamin Muhanguzi) pass the staff check the row-level policy uses, so the data is visible to them.

The problem is that the CFO has **no way to see or be told about that queue**.

### 1. The CFO dashboard has no "Requisitions" menu item (main cause)

The shared requisition review queue is wired into the CFO dashboard, but the CFO sidebar has no entry that opens it. Every other reviewing dashboard — COO, CEO, CMO, CRM, HR — has a "Requisitions" item; the CFO's Money Out section only has "Employee Requisitions", which opens the **older, unrelated** queue fed by public requisition links. So a CFO clicking the only requisition-looking menu item sees the legacy list and concludes nothing arrived.

### 2. The CFO approval bell does not watch staff requisitions

The CFO notification bell counts director requisitions, legacy employee requisitions, withdrawals, top-ups and so on, but has no entry for the new staff requisition table. It therefore stays silent and shows zero even while an item waits at the CFO stage.

### 3. Requisitions raised by a CFO-role user skip the CFO on purpose

To stop anyone reviewing their own money, the router sends a requester who holds the CFO role down a COO → CEO path instead of COO → CFO. 10 of the 33 requisitions so far went that way (all of Joshua Wanda's). That is correct separation of duties, not a bug — but nothing on the card explains it, so it looks like the CFO was skipped by accident.

## Fix

1. Add a **Requisitions** item to the CFO sidebar pointing at the shared staff requisition queue, and rename the existing legacy item to **Requisition Links (legacy)** so the two are not confused.
2. Add a staff-requisition queue to the CFO approval bell: count rows still awaiting a CFO decision and deep-link to the new tab.
3. On the requisition card, show the route it is taking (e.g. "Final approval: CEO — requester holds the CFO role") so a CFO-skipping route is visible and explained.

No change to the approval workflow, stages, permissions or wallet crediting logic.

## Technical detail

- `src/components/layout/executiveSidebarConfig.ts` — add `{ label: 'Requisitions', id: 'requisitions' }` to the `cfo` config (the `case 'requisitions'` branch in `src/pages/cfo/Dashboard.tsx` already renders `RequisitionsWorkspace`); relabel `employee-requisitions`.
- `src/hooks/useCfoApprovalNotifications.ts` — add a definition keyed on `staff_requisitions` with `stage = 'cfo'`, `tabId: 'requisitions'` (note the existing `directorRequisitions` entry already uses `tabId: 'requisitions'` and must be repointed to its own tab to avoid a collision).
- `src/components/requisitions/StaffRequisitionQueue.tsx` — render `final_stage` / `current_approver_role` in the row and detail sheet.
