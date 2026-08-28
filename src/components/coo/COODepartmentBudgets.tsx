import { useEffect, useState } from 'react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import BudgetReviewQueue from '@/components/budget/BudgetReviewQueue';
import { useBudgetCycles } from '@/hooks/useDepartmentBudgets';

/**
 * COO review stage for department budgets, scoped server-side to Tenant Ops,
 * Agent Ops, Landlord Ops and Partner Ops. Approval forwards the submission to
 * the CFO queue; a rejection or revision request returns it to the department.
 *
 * "Budgets awaiting approval" is deliberately unscoped by budget cycle so a
 * pending submission can never be hidden by the cycle selector below it.
 */
export default function COODepartmentBudgets() {
  const { cycles } = useBudgetCycles();
  const [cycleId, setCycleId] = useState('all');

  useEffect(() => { if (cycleId === 'all' && cycles.length) setCycleId(cycles[0].id); }, [cycles, cycleId]);

  return (
    <div className="space-y-6">
      <BudgetReviewQueue
        cycleId={null}
        stage="coo"
        onlyOpen
        intro="Every department budget routed to you and still awaiting your decision — across all budget cycles. Open one to review its items, amounts, periods and supporting documents, then approve or reject."
        emptyLabel="No budgets are awaiting your approval right now."
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm">All department budgets</CardTitle>
          <Select value={cycleId} onValueChange={setCycleId}>
            <SelectTrigger className="h-8 w-[240px] text-xs"><SelectValue placeholder="Budget cycle" /></SelectTrigger>
            <SelectContent className="z-[100]">
              <SelectItem value="all">All budget cycles</SelectItem>
              {cycles.map(c => (
                <SelectItem key={c.id} value={c.id}>
                  {c.title}{c.financial_year ? ` · ${c.financial_year}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          <BudgetReviewQueue cycleId={cycleId === 'all' ? null : cycleId} stage="coo" />
        </CardContent>
      </Card>
    </div>
  );
}
