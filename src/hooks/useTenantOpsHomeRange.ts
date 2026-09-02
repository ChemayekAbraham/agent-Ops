import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TenantOpsHomeRange {
  collected: number;
  expected: number;
  payments: number;
  tenants_paid: number;
  paid_tenants: number;
  unpaid_tenants: number;
  tenant_count: number;
  active_tenants: number;
  review_requests: number;
  new_requests: number;
  service_center_review: number;
  approvals: number;
  rejected: number;
  transfers: number;
  warning_behaviour: number;
  critical_behaviour: number;
  missed_days_tenants: number;
  critical_tenants: number;
}

const EMPTY: TenantOpsHomeRange = {
  collected: 0,
  expected: 0,
  payments: 0,
  tenants_paid: 0,
  paid_tenants: 0,
  unpaid_tenants: 0,
  tenant_count: 0,
  active_tenants: 0,
  review_requests: 0,
  new_requests: 0,
  service_center_review: 0,
  approvals: 0,
  rejected: 0,
  transfers: 0,
  warning_behaviour: 0,
  critical_behaviour: 0,
  missed_days_tenants: 0,
  critical_tenants: 0,
};

export function useTenantOpsHomeRange(startIso: string, endIso: string, enabled = true) {
  return useQuery({
    queryKey: ['tenant-ops-home-range', startIso, endIso],
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async (): Promise<TenantOpsHomeRange> => {
      const { data, error } = await supabase.rpc('ops_tenant_ops_home_range' as any, {
        p_start: startIso,
        p_end: endIso,
      });
      if (error) throw error;

      const raw = (data ?? {}) as Record<string, unknown>;
      return (Object.keys(EMPTY) as (keyof TenantOpsHomeRange)[]).reduce((result, key) => {
        result[key] = Number(raw[key] ?? 0);
        return result;
      }, { ...EMPTY });
    },
    placeholderData: EMPTY,
  });
}
