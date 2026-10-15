# Requisition Usage Report — receipt matching and accountability

## What exists today
- Requesters submit a usage report (amount used, what it was spent on, one receipt) from the "Your requisition was approved" pop-up.
- The CFO "Accountability" screen lists reports as Pending / Accepted / Clarification and can accept or ask for clarification.
- Live counts: 65 pending, 45 accepted, 1 clarification.
- Gaps: no receipt amount is captured, nothing compares amounts, there is no history of decisions (each decision overwrites the last), and a report sent back for clarification cannot be corrected by the requester.

## What changes for people

**Requester (pop-up form)**
- New field: "Amount on the receipt(s)". Allows several receipts, each with its own amount; total is added up.
- Each receipt can be marked "Receipt unreadable" or the requester can choose "No receipt available" — then no receipt amount is assumed.
- The difference (approved, used, receipt total) is shown live:
  - Amounts match: submits as today.
  - Do not match: a clear warning "Accountability required" appears; the requester must explain the difference (at least 20 characters), say what happened to any unspent balance, and attach supporting evidence where applicable.
- Missing, unreadable or multiple receipts always go to manual review — never auto-matched.
- If the reviewer returns the report, the requester sees "Correction needed" with the reviewer's note and can edit and resubmit the same report.

**Reviewer (CFO Accountability screen)**
- New tabs: Matched, Discrepancy, Needs receipt review, Returned for correction.
- Each report shows amount used, receipt total, difference, explanation, evidence and its full history.
- Actions: Approve, or Return for correction (reason of 10+ characters). A report cannot be approved twice.

## Rules enforced by the database (not just the screen)
- Difference is calculated by the system, never typed.
- A mismatched or receipt-problem report cannot be marked complete without explanation, balance account and reviewer approval.
- Every submit, resubmit, approve and return is recorded in an append-only history with who, when, amounts, difference, explanation and decision.
- Existing 111 reports are kept as they are and labelled "Before receipt matching".
- No payments, wallet changes, ledger entries or refunds are created. Unspent balance is only recorded, not collected.

## Testing
- A self-cleaning database test covering: match, over-receipt, under-receipt, missing receipt, unreadable receipt, multiple receipts, return and resubmit, double-approval refusal, and confirming no ledger/wallet rows change.
- Preview check of the form and review screen.

## Production
The database change has to be applied to the shared live database (preview and live app share one). I will only apply it after you approve this plan, and I will not publish the app.

## Technical details
- Migration: add nullable columns to `staff_requisition_usage_reports` (`receipt_total`, `amount_difference` generated, `match_status` matched|discrepancy|receipt_review|legacy, `discrepancy_explanation`, `balance_accounting`, `evidence_paths`, `receipt_items jsonb` [{path, amount, unreadable}], `no_receipt_reason`, `resubmitted_at`, `revision`); widen `review_status` to add `returned` (keeps existing values); backfill existing rows `match_status='legacy'`.
- New append-only `staff_requisition_usage_report_events` with grants + RLS (requester own, reviewers all; no update/delete).
- SECURITY DEFINER RPCs `usage_report_submit`, `usage_report_resubmit`, `usage_report_review(id, decision, note)` with FOR UPDATE row lock and same reviewer roles as the current policy; validation trigger blocks direct inserts that skip matching fields.
- Existing `pso_facilitation_report_guard` trigger and facilitation form untouched.
- UI: `RequisitionUsageReportGate.tsx`, `RequisitionUsageReportsReview.tsx`, small "Correction needed" entry in `src/pages/me/Requisitions.tsx`.
