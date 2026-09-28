import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Read-only notification layer for the CFO dashboard.
 *
 * Counts items already sitting in each queue's existing ready-for-CFO status —
 * exactly the same filters the corresponding panels use, so the badge always
 * matches what the CFO will actually see after jumping to the tab:
 *  - ROI Requests: pending_wallet_operations, category 'roi_payout', status 'coo_approved'
 *  - Rent Disbursements: rent_requests with status 'coo_approved'
 *  - Agent Advance Requests: agent_advance_requests pending / agent_ops_approved
 *  - Business Advances: business_advances status 'coo_approved'
 *  - Credit Access Draws: credit_access_draws status 'pending_cfo'
 *  - Allocation Returns / Unfunding: pending agent requests
 *  - Merchant Float Requests: float_requests status 'pending'
 *  - Agent Requisitions: pending_wallet_operations category 'agent_requisition', status 'pending'
 *  - Partner Top-ups: pending_wallet_operations operation_type 'portfolio_topup', status 'pending'
 *  - Director Requisitions: status 'pending'
 *  - Employee Requisitions: status 'pending' or 'pending_cfo' (COO-cleared)
 *  - Wallet Withdrawals: withdrawal_requests status 'pending'
 *
 * Each category is fetched as its own independent query: if one queue fails
 * (transient network error, temporary RLS hiccup), the other queues keep
 * showing their correct counts and only the affected category is reported as
 * unavailable.
 *
 * No approval logic is duplicated here — counts only. Polled every 60s (see
 * refetchInterval); exposes lastUpdatedAt + refresh() for the popover.
 */
export type CfoApprovalNotificationKey =
  | 'roi'
  | 'rent'
  | 'agentAdvances'
  | 'businessAdvances'
  | 'creditDraws'
  | 'allocationReturns'
  | 'unfunding'
  | 'merchantFloat'
  | 'agentRequisitions'
  | 'partnerTopups'
  | 'directorRequisitions'
  | 'employeeRequisitions'
  | 'staffRequisitions'
  | 'withdrawals';

export interface CfoApprovalNotification {
  key: CfoApprovalNotificationKey;
  title: string;
  count: number;
  tabId: string;
}

const HEAD = { count: 'exact' as const, head: true };

interface CategoryDef {
  key: CfoApprovalNotificationKey;
  title: string;
  tabId: string;
  table: string;
  fetchCount: () => PromiseLike<{ count: number | null; error: unknown }>;
}

const DEFINITIONS: CategoryDef[] = [
  {
    key: 'roi',
    title: 'ROI Requests Awaiting Approval',
    tabId: 'roi-requests',
    table: 'pending_wallet_operations',
    fetchCount: () =>
      supabase
        .from('pending_wallet_operations')
        .select('id', HEAD)
        .eq('category', 'roi_payout')
        .eq('status', 'coo_approved'),
  },
  {
    key: 'rent',
    title: 'Rent Disbursements Awaiting Approval',
    tabId: 'landlord-payout-float',
    table: 'rent_requests',
    fetchCount: () => supabase.from('rent_requests').select('id', HEAD).eq('status', 'coo_approved'),
  },
  {
    key: 'agentAdvances',
    title: 'Agent Advance Requests Awaiting Approval',
    tabId: 'advances',
    table: 'agent_advance_requests',
    fetchCount: () =>
      supabase
        .from('agent_advance_requests')
        .select('id', HEAD)
        .in('status', ['pending', 'agent_ops_approved']),
  },
  {
    key: 'businessAdvances',
    title: 'Business Advances Awaiting Disbursement',
    tabId: 'advances',
    table: 'business_advances',
    fetchCount: () =>
      (supabase as any).from('business_advances').select('id', HEAD).eq('status', 'coo_approved'),
  },
  {
    key: 'creditDraws',
    title: 'Credit Access Draws Awaiting Approval',
    tabId: 'wallet-payout',
    table: 'credit_access_draws',
    fetchCount: () =>
      supabase.from('credit_access_draws').select('id', HEAD).eq('status', 'pending_cfo'),
  },
  {
    key: 'allocationReturns',
    title: 'Allocation Returns Awaiting Approval',
    tabId: 'unfunding-approvals',
    table: 'agent_allocation_return_requests',
    fetchCount: () =>
      (supabase as any)
        .from('agent_allocation_return_requests')
        .select('id', HEAD)
        .eq('status', 'pending'),
  },
  {
    key: 'unfunding',
    title: 'Unfunding Requests Awaiting Approval',
    tabId: 'unfunding-approvals',
    table: 'agent_unfunding_requests',
    fetchCount: () =>
      supabase.from('agent_unfunding_requests').select('id', HEAD).eq('status', 'pending'),
  },
  {
    key: 'merchantFloat',
    title: 'Merchant Float Requests Awaiting Approval',
    tabId: 'merchant-float',
    table: 'float_requests',
    fetchCount: () => supabase.from('float_requests').select('id', HEAD).eq('status', 'pending'),
  },
  {
    key: 'agentRequisitions',
    title: 'Agent Requisitions Awaiting Approval',
    tabId: 'agent-requisitions',
    table: 'pending_wallet_operations',
    fetchCount: () =>
      supabase
        .from('pending_wallet_operations')
        .select('id', HEAD)
        .eq('category', 'agent_requisition')
        .eq('status', 'pending'),
  },
  {
    key: 'partnerTopups',
    title: 'Partner Top-ups Awaiting Verification',
    tabId: 'partner-topups',
    table: 'pending_wallet_operations',
    fetchCount: () =>
      supabase
        .from('pending_wallet_operations')
        .select('id', HEAD)
        .eq('operation_type', 'portfolio_topup')
        .eq('status', 'pending'),
  },
  {
    key: 'directorRequisitions',
    title: 'Director Requisitions Awaiting Approval',
    tabId: 'requisitions',
    table: 'director_requisitions',
    fetchCount: () =>
      supabase.from('director_requisitions').select('id', HEAD).eq('status', 'pending'),
  },
  {
    key: 'employeeRequisitions',
    title: 'Employee Requisitions Awaiting Approval',
    tabId: 'employee-requisitions',
    table: 'employee_requisitions',
    // 'pending' = legacy single-stage flow; 'pending_cfo' = a COO-cleared row
    // under the newer COO -> CFO flow. Both are awaiting a CFO decision.
    fetchCount: () =>
      supabase.from('employee_requisitions').select('id', HEAD).in('status', ['pending', 'pending_cfo']),
  },
  {
    // Staff requisitions (My Space -> department head -> COO -> CFO). Counts only
    // rows the COO has already passed on and that are parked at the CFO stage,
    // which is exactly what the shared queue's "Awaiting my review" tab shows.
    key: 'staffRequisitions',
    title: 'Staff Requisitions Awaiting CFO Approval',
    tabId: 'requisitions',
    table: 'staff_requisitions',
    fetchCount: () =>
      supabase.from('staff_requisitions').select('id', HEAD).eq('stage', 'cfo'),
  },
  {
    key: 'withdrawals',
    title: 'Wallet Withdrawals Awaiting Approval',
    tabId: 'withdrawals',
    table: 'withdrawal_requests',
    fetchCount: () =>
      supabase.from('withdrawal_requests').select('id', HEAD).eq('status', 'pending'),
  },
];

export function useCfoApprovalNotifications() {
  const queryClient = useQueryClient();

  // One independent query per approval queue — a failure in one queue can
  // never blank out the others.
  const results = useQueries({
    queries: DEFINITIONS.map((def) => ({
      queryKey: ['cfo-approval-notifications', def.key],
      staleTime: 30_000,
      refetchInterval: 60_000,
      retry: 1,
      queryFn: async () => {
        const res = await def.fetchCount();
        if (res.error) throw res.error;
        return res.count ?? 0;
      },
    })),
  }) as UseQueryResult<number>[];

  // No Realtime channel: the old one listened unfiltered to 12 tables
  // (several of them high-churn) and re-ran all 14 count queries on every
  // change anywhere. The 60s refetchInterval above keeps the badge current
  // (doc 147). refresh() is for the popover's manual refresh button.
  const refresh = async () => {
    await queryClient.refetchQueries({ queryKey: ['cfo-approval-notifications'] });
  };
  const updatedAtMs = Math.max(0, ...results.map((r) => r.dataUpdatedAt || 0));
  const lastUpdatedAt = updatedAtMs > 0 ? new Date(updatedAtMs) : null;

  const counts = {} as Record<CfoApprovalNotificationKey, number>;
  DEFINITIONS.forEach((def, i) => {
    const r = results[i];
    // Failed categories contribute 0 to the badge but are surfaced separately
    // via `failed` — never silently treated as "no items".
    counts[def.key] = r?.data ?? 0;
  });

  const failed: CfoApprovalNotification[] = DEFINITIONS.filter(
    (_, i) => results[i]?.isError,
  ).map((d) => ({ key: d.key, title: d.title, tabId: d.tabId, count: 0 }));

  const isLoading = results.some((r) => r.isLoading);

  const notifications: CfoApprovalNotification[] = DEFINITIONS.map((d, i) => ({
    key: d.key,
    title: d.title,
    tabId: d.tabId,
    count: results[i]?.isError ? 0 : (results[i]?.data ?? 0),
  })).filter((n) => n.count > 0);

  return {
    isLoading,
    roiCount: counts.roi,
    rentCount: counts.rent,
    counts,
    total: notifications.reduce((sum, n) => sum + n.count, 0),
    notifications,
    failed,
    lastUpdatedAt,
    refresh,
  };
}
