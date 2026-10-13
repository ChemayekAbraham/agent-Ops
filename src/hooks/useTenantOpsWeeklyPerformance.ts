/**
 * Tenant Ops "Weekly Performance" — Wednesday-to-Tuesday reporting week.
 *
 * Reads get_tenant_ops_weekly_performance_amclock() / get_tenant_ops_weekly_history_amclock().
 * Every plan is counted from the day after the landlord was paid (am_plan_clock), as in Agent
 * Monitoring. Weeks before the first week counted that way come back exactly as they were frozen
 * and are marked `counting: 'old'`. No client-side arithmetic beyond formatting — every count,
 * rate and delta comes from the server.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export { WEEKLY_CLOCK_NOTE, WEEKLY_COUNTING_CHANGED_NOTE, landlordNotPaidLine } from '@/lib/tenantOpsWeeklyNotes';

export interface TenantOpsWeeklyMetrics {
  total_active_tenants: number;
  paying_tenants: number;
  non_paying_tenants: number;
  new_tenants_added: number;
  payment_rate_pct: number;
  /** Distinct tenants who self-paid via a merchant/mobile-money channel that week. */
  self_payment_tenants: number;
  /** Tenants currently 20+ days without a payment (snapshot as of when this week was frozen). */
  dormant_20_plus_count: number;
  /** Live Rent Plans whose landlord is not paid yet — not counted as owing. Null for weeks frozen the old way. */
  landlord_not_paid_count?: number | null;
}

/** How a week was counted: 'amclock' = from the day after the landlord was paid; 'old' = frozen before that change. */
export type WeeklyCounting = 'amclock' | 'old';

export interface TenantOpsWeeklyPerformance {
  week_start: string;
  week_end: string;
  is_current_week_open: boolean;
  counting?: WeeklyCounting;
  first_amclock_week?: string;
  /** True for the first week counted from the landlord-paid clock. */
  counting_changed_this_week?: boolean;
  current: TenantOpsWeeklyMetrics;
  previous: TenantOpsWeeklyMetrics & { week_start: string; week_end: string; counting?: WeeklyCounting };
  delta: Omit<TenantOpsWeeklyMetrics, 'landlord_not_paid_count'> & {
    landlord_not_paid_count?: number | null;
    /** Week-on-week % change in self-paying tenants; null when the prior week had none to compare against. */
    self_payment_increase_pct: number | null;
  };
}

export interface TenantOpsWeeklyHistoryRow extends TenantOpsWeeklyMetrics {
  week_start: string;
  week_end: string;
  captured_at: string;
  counting?: WeeklyCounting;
  /** True on the first week counted from the landlord-paid clock. */
  counting_changed?: boolean;
}

/** `anchor` picks which reporting week to view (defaults to the current open week). */
export function useTenantOpsWeeklyPerformance(anchor?: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ['tenant-ops-weekly-performance', 'amclock', anchor ?? null],
    enabled,
    staleTime: 120_000,
    refetchInterval: 180_000,
    queryFn: async (): Promise<TenantOpsWeeklyPerformance> => {
      const { data, error } = await anyDb.rpc('get_tenant_ops_weekly_performance_amclock', {
        p_anchor: anchor ?? null,
      });
      if (error) throw new Error(error.message);
      return data as TenantOpsWeeklyPerformance;
    },
  });
}

export function useTenantOpsWeeklyHistory(limit: number = 12, enabled: boolean = true) {
  return useQuery({
    queryKey: ['tenant-ops-weekly-history', 'amclock', limit],
    enabled,
    staleTime: 300_000,
    queryFn: async (): Promise<TenantOpsWeeklyHistoryRow[]> => {
      const { data, error } = await anyDb.rpc('get_tenant_ops_weekly_history_amclock', { p_limit: limit });
      if (error) throw new Error(error.message);
      return (data ?? []) as TenantOpsWeeklyHistoryRow[];
    },
  });
}
