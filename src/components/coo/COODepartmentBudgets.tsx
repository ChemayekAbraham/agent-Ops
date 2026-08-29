import BudgetReviewQueue from '@/components/budget/BudgetReviewQueue';

/**
 * COO review stage for department budgets, scoped server-side to Tenant Ops,
 * Agent Ops, Landlord Ops and Partner Ops. Approval forwards the submission to
 * the CFO queue; a rejection or revision request returns it to the department.
 *
 * The queue is deliberately unscoped by budget cycle so a pending submission can
 * never be hidden by a cycle selector.
 */
export default function COODepartmentBudgets() {
  return (
    <BudgetReviewQueue
      cycleId={null}
      stage="coo"
      onlyOpen
      intro="Every department budget routed to you and still awaiting your decision. Select a request to open the full budget details, then approve or reject."
      emptyLabel="No budgets are awaiting your approval right now."
    />
  );
}

