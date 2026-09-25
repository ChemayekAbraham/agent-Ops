/**
 * Tenant Ops "Weekly Performance" — Wednesday-to-Tuesday reporting week.
 *
 * Reads get_tenant_ops_weekly_performance() / get_tenant_ops_weekly_history().
 * No client-side arithmetic beyond formatting — every count, rate and delta
 * comes from the server, and the previous week's figures are the frozen,
 * never-recomputed record once that week has closed.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface TenantOpsWeeklyMetrics {
  total_active_tenants: number;
  paying_tenants: number;
  non_paying_tenants: number;
  new_tenants_added: number;
  payment_rate_pct: number;
}

export interface TenantOpsWeeklyPerformance {
  week_start: string;
  week_end: string;
  is_current_week_open: boolean;
  current: TenantOpsWeeklyMetrics;
  previous: TenantOpsWeeklyMetrics & { week_start: string; week_end: string };
  delta: TenantOpsWeeklyMetrics;
}

export interface TenantOpsWeeklyHistoryRow extends TenantOpsWeeklyMetrics {
  week_start: string;
  week_end: string;
  captured_at: string;
}

/** `anchor` picks which reporting week to view (defaults to the current open week). */
export function useTenantOpsWeeklyPerformance(anchor?: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ['tenant-ops-weekly-performance', anchor ?? null],
    enabled,
    staleTime: 120_000,
    refetchInterval: 180_000,
    queryFn: async (): Promise<TenantOpsWeeklyPerformance> => {
      const { data, error } = await anyDb.rpc('get_tenant_ops_weekly_performance', {
        p_anchor: anchor ?? null,
      });
      if (error) throw new Error(error.message);
      return data as TenantOpsWeeklyPerformance;
    },
  });
}

export function useTenantOpsWeeklyHistory(limit: number = 12, enabled: boolean = true) {
  return useQuery({
    queryKey: ['tenant-ops-weekly-history', limit],
    enabled,
    staleTime: 300_000,
    queryFn: async (): Promise<TenantOpsWeeklyHistoryRow[]> => {
      const { data, error } = await anyDb.rpc('get_tenant_ops_weekly_history', { p_limit: limit });
      if (error) throw new Error(error.message);
      return (data ?? []) as TenantOpsWeeklyHistoryRow[];
    },
  });
}
