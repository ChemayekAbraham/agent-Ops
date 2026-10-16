import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  CooApprovalResult,
  LandlordFloatAllocationRow,
  LandlordFloatBudgetHistoryRow,
  LandlordFloatBudgetStatus,
  LandlordFloatMiscRow,
  LandlordFloatMiscStatus,
  LandlordFloatPosition,
  MiscDecisionResult,
  MiscRequestResult,
  ReturnToCooResult,
  SetBudgetResult,
} from '@/lib/landlordFloatBudget';

/**
 * Landlord float budget cap — data layer for the COO and CFO dashboards.
 *
 * Every read is one RPC that already joins the names it shows (no per-row lookups), and every write is one RPC
 * that takes a whole batch and returns the new budget position, which is written straight into the status cache
 * so the budget bar updates without another round trip. All rules (who may act, what fits, locking) live in the
 * database; see src/lib/landlordFloatBudget.ts and the 20261016140000 migration.
 */

export const LANDLORD_FLOAT_BUDGET_KEY = ['landlord-float-budget'] as const;
const statusKey = [...LANDLORD_FLOAT_BUDGET_KEY, 'status'] as const;

// The generated Database types do not know these functions until Lovable regenerates them after the migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpc = (fn: string, args?: Record<string, unknown>) => supabase.rpc(fn as any, args as any);

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Budget, used, room left, pending miscellaneous asks and what the viewer may do — one call. */
export function useLandlordFloatBudgetStatus(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: statusKey,
    enabled: options.enabled ?? true,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: () => call<LandlordFloatBudgetStatus>('get_landlord_float_budget_status'),
  });
}

export function useLandlordFloatBudgetHistory(periodType?: 'daily' | 'weekly', limit = 60) {
  return useQuery({
    queryKey: [...LANDLORD_FLOAT_BUDGET_KEY, 'history', periodType ?? 'all', limit],
    staleTime: 60_000,
    queryFn: () =>
      call<LandlordFloatBudgetHistoryRow[]>('get_landlord_float_budget_history', {
        p_period_type: periodType ?? null,
        p_limit: limit,
      }),
  });
}

/** Every approval made against one day or week (live and released). */
export function useLandlordFloatBudgetAllocations(periodType: 'daily' | 'weekly', periodStart: string | null) {
  return useQuery({
    queryKey: [...LANDLORD_FLOAT_BUDGET_KEY, 'allocations', periodType, periodStart],
    enabled: !!periodStart,
    staleTime: 60_000,
    queryFn: () =>
      call<LandlordFloatAllocationRow[]>('get_landlord_float_budget_allocations', {
        p_period_type: periodType,
        p_period_start: periodStart,
      }),
  });
}

/** Miscellaneous asks with the request details (tenant, landlord, agent, who asked). null status = all. */
export function useLandlordFloatMiscQueue(status: LandlordFloatMiscStatus | null = 'pending', limit = 200) {
  return useQuery({
    queryKey: [...LANDLORD_FLOAT_BUDGET_KEY, 'misc', status ?? 'all', limit],
    staleTime: 30_000,
    queryFn: () =>
      call<LandlordFloatMiscRow[]>('get_landlord_float_misc_queue', { p_status: status, p_limit: limit }),
  });
}

/**
 * After a write: put the returned position into the status cache (no refetch needed for the bar), refresh the
 * lists that changed, and refresh the rent pipeline queues the request moved between.
 */
function settle(qc: QueryClient, position: LandlordFloatPosition | undefined, touchesPipeline: boolean) {
  if (position) {
    qc.setQueryData<LandlordFloatBudgetStatus>(statusKey, prev => (prev ? { ...prev, ...position } : prev));
  }
  // Pending-miscellaneous lists and history are cheap single calls; the status is refreshed too so pending_misc
  // (not part of the position) stays right.
  qc.invalidateQueries({ queryKey: LANDLORD_FLOAT_BUDGET_KEY });
  if (touchesPipeline) {
    qc.invalidateQueries({ queryKey: ['rent-pipeline'] });
    qc.invalidateQueries({ queryKey: ['pipeline-counts'] });
    qc.invalidateQueries({ queryKey: ['rent-disbursement-queue'] });
  }
}

export function useLandlordFloatBudgetActions() {
  const qc = useQueryClient();

  /** CFO: set (or change) the daily or weekly budget. A daily above the weekly needs a reason. */
  const setBudget = useMutation({
    mutationFn: (input: { periodType: 'daily' | 'weekly'; amount: number; reason?: string; periodStart?: string }) =>
      call<SetBudgetResult>('cfo_set_landlord_float_budget', {
        p_period_type: input.periodType,
        p_amount: input.amount,
        p_reason: input.reason?.trim() || null,
        p_period_start: input.periodStart ?? null,
      }),
    onSuccess: res => settle(qc, res?.status, false),
  });

  /** COO: forward requests to the CFO inside the budget. One call for one or many; over-cap ones stay put. */
  const approveAtCoo = useMutation({
    mutationFn: (input: { requestIds: string[]; comment?: string }) =>
      call<CooApprovalResult>('coo_approve_rent_requests', {
        p_request_ids: input.requestIds,
        p_comment: input.comment?.trim() || null,
      }),
    onSuccess: res => settle(qc, res?.status, (res?.approved?.length ?? 0) > 0),
  });

  /** COO: ask the CFO to approve requests above the budget, one reason per request. */
  const requestMisc = useMutation({
    mutationFn: (items: { rentRequestId: string; reason: string }[]) =>
      call<MiscRequestResult>('coo_request_landlord_float_misc', {
        p_items: items.map(i => ({ rent_request_id: i.rentRequestId, reason: i.reason.trim() })),
      }),
    onSuccess: () => settle(qc, undefined, false),
  });

  /** CFO: approve (moves the request to the CFO stage outside the cap) or reject (stays at the COO step). */
  const decideMisc = useMutation({
    mutationFn: (input: { miscIds: string[]; decision: 'approve' | 'reject'; note?: string }) =>
      call<MiscDecisionResult>('cfo_decide_landlord_float_misc', {
        p_misc_ids: input.miscIds,
        p_decision: input.decision,
        p_note: input.note?.trim() || null,
      }),
    onSuccess: res => settle(qc, res?.status, (res?.approved?.length ?? 0) > 0),
  });

  /** CFO: send requests at the disbursement step back to the COO; their amount returns to the budget. */
  const returnToCoo = useMutation({
    mutationFn: (input: { requestIds: string[]; reason: string }) =>
      call<ReturnToCooResult>('cfo_return_rent_requests_to_coo', {
        p_request_ids: input.requestIds,
        p_reason: input.reason.trim(),
      }),
    onSuccess: res => settle(qc, res?.status, (res?.returned?.length ?? 0) > 0),
  });

  return { setBudget, approveAtCoo, requestMisc, decideMisc, returnToCoo };
}
