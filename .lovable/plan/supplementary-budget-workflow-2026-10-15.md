# Supplementary Budget workflow

## What exists today
- Departments submit budgets per budget cycle (financial year, period). Each budget has line items with account codes, justifications and documents.
- Approval path: department head → COO first (Operations departments only, set per department) → CFO decides each line and finalises. People cannot approve their own budgets. Every step is recorded in the budget event history.
- CFO reports already read actual spending per account from the books (read-only).
- Today: 23 budgets, none fully approved yet (10 under CFO review, 7 at COO, 2 submitted, 4 rejected).
- There is no budget reallocation feature yet, so nothing needs separating from it now. The new design keeps supplements in their own records, so any future reallocation stays separate.

## Important: approval needed before any database change
The preview and the live app share one database. Creating the new records and approval steps changes production, even if nobody uses them. Approving this plan is the explicit go-ahead for that. Without it, I will only write the files and tests and apply nothing.

## What will be built (all new, nothing existing edited)
1. **Request a supplement.** From an approved budget, a department head (or someone allowed to file for that department) picks a budget line and enters the extra amount, financial year, justification (at least 20 characters) and supporting documents (same private storage as budget documents). Only one open supplement per line at a time.
2. **Approval** follows the same route as the original budget: COO first for COO-routed departments, then the CFO. The same people who can approve budgets today approve supplements, using the same checks. Requesters cannot approve their own. Each stage can approve or reject with a reason of at least 10 characters.
3. **Revised budget.** The original approved budget is never changed. Revised = original approved + supplements approved by the CFO, calculated only after final authorisation.
4. **No double approvals.** Each decision locks the request row and checks its current status. A second click or a repeat decision is refused, and each supplement can add to the revised budget only once.
5. **Audit trail.** Every create, submit, approve, reject and cancel is written to an append-only history (who, when, before/after, reason) and also emits a system event.
6. **CFO report.** A new "Supplementary budgets" tab in the CFO budget area, plus a per-line table: Original | Approved supplements | Revised | Actual spending | Remaining. Includes a review queue for pending supplements.
7. **No money moves.** No payments, ledger entries, wallet changes or releases. Supplements are never linked to the existing budget release step.

## Testing
- Database test script covering request, COO and CFO approval, rejection, self-approval refusal, duplicate-approval refusal, a supplement on an unapproved budget, and checks that the revised totals are correct and no ledger or wallet rows were created. It runs inside a transaction that is rolled back.
- Screen checks in the preview, plus a check that existing budget screens still work.
- Nothing is published.

## Technical details
- New table `budget_supplements` (submission_id, line_id, department_id, financial_year, amount, justification, status draft/pending_coo/pending_cfo/approved/rejected/cancelled, COO and CFO decision fields, version). A partial unique index allows one open supplement per line. Grants, RLS and read access come from the existing `budget_can_access_department` and reviewer helpers.
- New tables `budget_supplement_documents` and `budget_supplement_events` (append-only, no update or delete policy).
- New SECURITY DEFINER RPCs: `budget_supplement_create/submit/cancel`, `budget_supplement_coo_decide`, `budget_supplement_cfo_decide` (`FOR UPDATE` plus status guard; reuses `budget_department_route`, `is_cfo_approver`, `is_budget_reviewer`), `budget_supplement_queue`, and the read-only `budget_revised_position(p_call_id)` joining `budget_actuals_by_account`.
- UI: a new component in `src/components/budget/` (request dialog), a new CFO tab in `BudgetApprovalPanel`, and a new hook. Existing components are only touched to add a button or tab.
- The existing `budget_*` functions, and the guard against the frontend writing to the ledger, stay as they are. AGENTS.md gets one rule.
