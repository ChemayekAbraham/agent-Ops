import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Weekly budget lines a requisition may reference — data layer for the requisition forms' budget-line
 * picker (migration 20261020200000_requisition_budget_line_reference).
 *
 * The server returns only lines that pass every rule today: budget on the CFO dashboard, this week's
 * ('5days') call, the requester's department (when one is known), not rejected — with what is already
 * committed and what is left. Only people who may raise requisitions can call it, and `departmentId` must
 * be one of their own (HR department, routed department, or Agent Ops for Agents' Space agents);
 * anything else is refused. The database trigger re-checks on submit under a lock, so this list is a
 * convenience, never the authority. Requisitions themselves are still filed through the existing edge
 * functions with `budget_line_id` in the body.
 */

export interface RequisitionBudgetLine {
  line_id: string;
  department_id: string | null;
  department_name: string | null;
  call_id: string;
  call_title: string | null;
  period_start: string;
  period_end: string;
  description: string | null;
  category: string | null;
  account_code: string | null;
  /** The submitted amount of the line. */
  line_total: number;
  /** Supplementary budgets that reached the CFO (pending or approved), at the amount requested. */
  supplements: number;
  /** line_total + supplements: what requisitions on this line may add up to. */
  allowance: number;
  committed: number;
  remaining: number;
}

/** Rule codes the requisition functions return when a budget line is refused (HTTP 400, or 409 when over budget). */
export type RequisitionBudgetLineCode =
  | 'BUDGET_LINE_REQUIRED'
  | 'BUDGET_LINE_NOT_FOUND'
  | 'BUDGET_LINE_REJECTED'
  | 'BUDGET_NOT_ON_CFO_DASHBOARD'
  | 'BUDGET_LINE_WRONG_WEEK'
  | 'BUDGET_LINE_OTHER_DEPARTMENT'
  | 'BUDGET_LINE_OVER_BUDGET'
  | 'BUDGET_LINE_LOCKED';

export const REQUISITION_BUDGET_LINES_KEY = ['requisition-budget-lines'] as const;

// The generated Database types do not know this function until Lovable regenerates them after the migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpc = (fn: string, args?: Record<string, unknown>) => supabase.rpc(fn as any, args as any);

/**
 * @param departmentId the department the requisition will be filed under (as staff_requisition_route
 *   returns it); omit to use the signed-in person's HR department(s).
 */
export function useRequisitionBudgetLines(departmentId?: string | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...REQUISITION_BUDGET_LINES_KEY, departmentId ?? 'mine'],
    enabled: options.enabled ?? true,
    staleTime: 30_000,
    queryFn: async (): Promise<RequisitionBudgetLine[]> => {
      const { data, error } = await rpc('requisition_budget_lines_available', {
        p_department_id: departmentId ?? null,
      });
      if (error) throw new Error(error.message);
      return ((data as RequisitionBudgetLine[] | null) ?? []).map((line) => ({
        ...line,
        line_total: Number(line.line_total),
        supplements: Number(line.supplements),
        allowance: Number(line.allowance),
        committed: Number(line.committed),
        remaining: Number(line.remaining),
      }));
    },
  });
}
