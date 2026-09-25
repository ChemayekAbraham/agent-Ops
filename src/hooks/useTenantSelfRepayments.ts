import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TenantSelfRepaymentRow {
  attempt_id: string;
  paid_at: string;
  tenant_id: string | null;
  tenant_name: string | null;
  paid_from_phone: string | null;
  deposit_request_id: string | null;
  amount_deposited: number | null;
  provider: string | null;
  external_reference: string | null;
  applied_amount: number | null;
  surplus_amount: number | null;
  /** What actually stayed in the tenant's wallet: surplus for settled rows,
   *  full deposit minus applied for refused rows (deposits are credited at
   *  approval time regardless of the repayment outcome). */
  float_kept: number | null;
  /** Which wallet bucket the kept amount sits in ('float' | 'withdrawable'). */
  kept_bucket: string | null;
  outcome: string | null;
  refusal_reason: string | null;
  rent_request_id: string | null;
  total_repayment: number | null;
  amount_repaid: number | null;
  outstanding_after: number | null;
  plan_status: string | null;
  agent_id: string | null;
  agent_name: string | null;
  commission_agent: number | null;
  commission_parent: number | null;
  commission_total: number | null;
  parent_agent_id: string | null;
  transaction_group_id: string | null;
  tracking_id: string | null;
  collection_channel: string | null;
  performance_weight: number | null;
}

export interface TenantSelfRepaymentTotals {
  settled_count: number;
  refused_count: number;
  total_applied: number;
  total_surplus: number;
  total_commission: number;
  /** Distinct tenants behind the settled rows in this range (settled_count counts attempts, not people). */
  distinct_tenant_count: number;
}

export interface TenantSelfRepaymentFilters {
  days: number;
  outcome: string;
  search: string;
  page: number;
  pageSize: number;
}

const EMPTY_TOTALS: TenantSelfRepaymentTotals = {
  settled_count: 0,
  refused_count: 0,
  total_applied: 0,
  total_surplus: 0,
  total_commission: 0,
  distinct_tenant_count: 0,
};

/**
 * Single reader for the tenant self-repayment ledger, shared by the CFO,
 * Tenant Ops and Agent Ops surfaces. One round trip returns rows, the total
 * count and the aggregate figures, so no surface needs a second query or a
 * per-row lookup.
 */
export function useTenantSelfRepayments(initial?: Partial<TenantSelfRepaymentFilters>) {
  const [filters, setFilters] = useState<TenantSelfRepaymentFilters>({
    days: initial?.days ?? 30,
    outcome: initial?.outcome ?? 'all',
    search: initial?.search ?? '',
    page: initial?.page ?? 0,
    pageSize: initial?.pageSize ?? 50,
  });

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - filters.days * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [filters.days]);

  const query = useQuery({
    queryKey: ['tenant-self-repayments', range.from, range.to, filters.outcome, filters.search, filters.page, filters.pageSize],
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_tenant_self_repayments', {
        p_from: range.from,
        p_to: range.to,
        p_outcome: filters.outcome === 'all' ? null : filters.outcome,
        p_search: filters.search.trim() || null,
        p_limit: filters.pageSize,
        p_offset: filters.page * filters.pageSize,
      } as any);
      if (error) throw error;
      const payload = (data ?? {}) as any;
      return {
        rows: (payload.rows ?? []) as TenantSelfRepaymentRow[],
        total: Number(payload.total ?? 0),
        totals: { ...EMPTY_TOTALS, ...(payload.totals ?? {}) } as TenantSelfRepaymentTotals,
      };
    },
  });

  const update = (patch: Partial<TenantSelfRepaymentFilters>) =>
    setFilters(prev => ({
      ...prev,
      ...patch,
      // any filter change resets pagination unless the page itself moved
      page: patch.page !== undefined ? patch.page : 0,
    }));

  return {
    filters,
    setFilters: update,
    rows: query.data?.rows ?? [],
    total: query.data?.total ?? 0,
    totals: query.data?.totals ?? EMPTY_TOTALS,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}
