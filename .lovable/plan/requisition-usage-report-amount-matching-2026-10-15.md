# Requisition Usage Report — Amount Matching

## What the requester will see (usage report popup)
- Three amounts side by side: **Approved amount** (read-only, from the requisition), **Amount used** (typed by the requester), **Receipt total** (typed by the requester from the receipts, it is not read from the receipts automatically).
- Differences are worked out as you type:
  - Receipt total vs amount used. If they don't match, a red "Discrepancy" flag shows and a written explanation (at least 10 characters) is required.
  - Approved amount vs receipt total (the verified spend). If there's money left over, the popup shows "Unspent balance UGX X" and asks for a written explanation of the balance plus a refund status: *Refund made* (attach proof of the refund), *Refund pending* or *Not required per policy* (with a reason).
  - If the receipt total is more than the approved amount (overspend), an explanation is required.
- Submit stays disabled until every required explanation and piece of evidence is in. Flagged reports go to the CFO as **Needs review**, not as clean.

## What the CFO will see (review queue)
- Approved, used and receipt totals, plus both differences, on each row and in the detail view, with a flag badge on any mismatch.
- The receipt total can be confirmed or corrected after manual checking (a "Verified receipt total" with a required note).
- Accept stays blocked on a flagged report until the CFO records a decision: **Accept discrepancy**, **Request clarification** or **Require refund**. Each decision needs a 10-character note.

## Audit trail
- Every amount, explanation, refund status, receipt list, reviewer verification and decision is saved and logged in the existing usage-report event log and audit log. Nothing gets overwritten: reviewer corrections go in as new rows.

## Not changed
- Requisition approvals, amounts and routes, deferral rules and the 36-hour grace period all stay as they are. No payments, wallet changes or ledger entries are made.

## Testing
- A database test that rolls itself back, covering: an exact match; a receipt total that doesn't match the amount used (blocked without an explanation); an unspent balance (blocked without an explanation or refund status, and refund proof is required when "Refund made" is chosen); an overspend; the CFO correcting the receipt total; Accept being blocked on a flagged report until a decision is recorded.
- Unit tests for the difference maths. A preview click-through while signed in.

## Deployment
- This needs a database change on the shared live database, which the preview and the live app both use. **I won't apply it until you explicitly approve.** Once you approve the plan, I'll ask again right before I apply the database change. The screen changes stay preview-only until you say publish.

## Technical details
- Additive columns on `staff_requisition_usage_reports`: `receipt_total`, `receipt_mismatch_explanation`, `unspent_explanation`, `refund_status` (`made|pending|not_required`), `refund_evidence_paths`, `refund_not_required_reason`, `discrepancy_flag` (generated).
- New append-only `staff_requisition_usage_report_reviews` table: verified_receipt_total, decision, note, reviewer, time. It has grants and RLS for the requester, CFO and super_admin.
- `submit_requisition_usage_report` SECURITY DEFINER RPC validates all the rules on the server, inserts the report, and writes the event and audit entries. The client switches from a direct insert to this RPC.
- `review_requisition_usage_report` RPC enforces the decision requirement before a flagged report can be accepted.
- Pure helper `src/lib/usageReportMatching.ts` with vitest tests.
