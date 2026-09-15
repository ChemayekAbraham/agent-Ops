# Receipt attachment on the requisition usage report

Add an optional receipt / supporting document (image or PDF) to the usage report form that already appears in the approval popup, and make that receipt viewable afterwards by the requester and by finance/CFO reviewers.

## What changes for people

- The popup form keeps its two existing fields (amount used, what it was spent on) and gains a third: **Receipt or supporting document (optional)** accepting JPG, PNG, WebP or PDF up to 10MB.
- The requester submits amount, description and file in one action. The reminder still returns every 5 minutes and still stops only once the report is saved.
- After submission the receipt stays available: the requester sees it on their requisitions page, and finance/CFO reviewers see the submitted usage report with a "View receipt" link in the staff requisition review queue.

## Reuse, not duplication

The project already has the exact machinery for this and it is used unchanged:

- Existing private storage bucket `requisition-attachments`.
- Existing upload function `staff-requisition-add-attachment` (validates type, size, ownership, max 10 files, records a `receipt_attached` event).
- Existing viewer function `staff-requisition-attachment-url` (short-lived signed URL; requester or cfo/coo/ceo/manager/super_admin only).

No new bucket, no new storage policy, no new auth path.

## Technical notes

1. Migration (additive only): add nullable `attachment_paths text[]` to `staff_requisition_usage_reports`. No column drops, renames or type changes; existing RLS untouched.
2. `RequisitionUsageReportGate.tsx`:
   - add a file input with client-side type/size validation matching the edge function's limits;
   - on submit, first upload the file through `staff-requisition-add-attachment` (multipart, `requisition_id` + `file`), then insert the report row including the returned storage path in `attachment_paths`;
   - if the upload fails, surface the error and do not save a report claiming a receipt — the user can retry or submit without one;
   - keep `load()`, the 5-minute interval and the dismiss/snooze behaviour exactly as they are.
3. Read-side surfacing (display only, no logic change):
   - `src/pages/me/Requisitions.tsx` — show the submitted usage report (amount used, description, receipt link) on the requester's own row, opening the file through the existing `staff-requisition-attachment-url` call already present in that file.
   - `src/components/requisitions/StaffRequisitionQueue.tsx` — show the same usage report block plus receipt link for reviewers; the row query already selects `attachment_urls`.
   - Both read paths batch by requisition id (single `in(...)` query), no per-row round trips.

## Out of scope

Approval flow, wallet/ledger movement, reminder timing, storage policies and every other requisition behaviour stay as they are.
