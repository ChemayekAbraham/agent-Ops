import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TenantOpsToolCounts {
  review_requests: number;
  new_requests: number;
  service_center_review: number;
  active_plans: number;
  repaying_plans: number;
  tenant_count: number;
  active_tenants: number;
  payments_today: number;
  collected_today: number;
  expected_today: number;
  tenants_paid_today: number;
  paid_today_tenants: number;
  unpaid_today_tenants: number;
  missed_days_tenants: number;
  critical_tenants: number;
  behavior_critical: number;
  behavior_warning: number;
  transfers_30d: number;
  approvals_today: number;
  rejected_30d: number;
}

const EMPTY: TenantOpsToolCounts = {
  review_requests: 0,
  new_requests: 0,
  service_center_review: 0,
  active_plans: 0,
  repaying_plans: 0,
  tenant_count: 0,
  active_tenants: 0,
  payments_today: 0,
  collected_today: 0,
  expected_today: 0,
  tenants_paid_today: 0,
  paid_today_tenants: 0,
  unpaid_today_tenants: 0,
  missed_days_tenants: 0,
  critical_tenants: 0,
  behavior_critical: 0,
  behavior_warning: 0,
  transfers_30d: 0,
  approvals_today: 0,
  rejected_30d: 0,
};

/**
 * Live, whole-system counts behind the Tenant Ops Tools cards.
 * Computed in the database (`ops_tenant_ops_tool_counts`) so badges are no
 * longer derived from a truncated client-side page of rent requests.
 */
export function useTenantOpsToolCounts() {
  return useQuery({
    queryKey: ['tenant-ops-tool-counts'],
    queryFn: async (): Promise<TenantOpsToolCounts> => {
      const { data, error } = await (supabase.rpc as any)('ops_tenant_ops_tool_counts');
      if (error) throw error;
      const raw = (data || {}) as Record<string, any>;
      const out = { ...EMPTY };
      (Object.keys(EMPTY) as (keyof TenantOpsToolCounts)[]).forEach(k => {
        out[k] = Number(raw[k] || 0);
      });
      return out;
    },
    staleTime: 30000,
    refetchInterval: 60000,
  });
}
