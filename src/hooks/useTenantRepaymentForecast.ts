import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface ForecastDay {
  day: string;
  scheduled_ugx: number;
  collected_ugx: number | null;
  plans: number;
  starting_plans: number;
  ending_plans: number;
  starting_ugx: number;
  ending_ugx: number;
  elapsed: boolean;
}

export interface TenantRepaymentForecast {
  timezone: string;
  today: string;
  window_start: string;
  window_end: string;
  days: number;
  expected_ugx: number;
  expected_to_date_ugx: number;
  collected_ugx: number;
  shortfall_to_date_ugx: number;
  collection_rate_pct: number | null;
  overdue_ugx: number;
  overdue_plans: number;
  overdue_as_of: string;
  drivers: {
    active_plans: number;
    avg_daily_ugx: number;
    remaining_obligation_ugx: number;
    starting_plans: number;
    starting_daily_ugx: number;
    ending_plans: number;
    ending_daily_ugx: number;
  };
  daily: ForecastDay[];
}

/**
 * Read-only forward repayment forecast for Tenant Ops.
 *
 * Everything is derived server-side by `ops_tenant_repayment_forecast`, which
 * reads the existing funded/active rent plans and existing collection records.
 * No obligation or rate is recomputed on the client.
 */
export function useTenantRepaymentForecast(startIso: string, endIso: string) {
  return useQuery({
    queryKey: ['tenant-repayment-forecast', startIso, endIso],
    enabled: Boolean(startIso && endIso),
    staleTime: 60_000,
    queryFn: async (): Promise<TenantRepaymentForecast | null> => {
      const { data, error } = await supabase.rpc('ops_tenant_repayment_forecast', {
        p_start: startIso,
        p_end: endIso,
      });
      if (error) throw error;
      return (data as unknown as TenantRepaymentForecast) ?? null;
    },
  });
}
