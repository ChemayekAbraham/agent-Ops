/**
 * Read-only payment collections projection for Tenant Ops → Tenant Products &
 * Services → Collections Forecast. All figures come from the server-side RPC
 * `get_payment_collections_projection` (history-based trend only; no manual
 * growth assumptions). Nothing here writes or derives money client-side.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type ProjectionGranularity = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type ProjectionQuality = 'high' | 'medium' | 'low';

export interface ProjectionHistoryPoint {
  date: string;
  amount: number;
}

export interface ProjectionPeriod {
  period_start: string;
  period_end: string;
  label: string;
  forecast_amount: number;
  low: number;
  high: number;
  confidence: number;
  quality: ProjectionQuality;
}

export interface ProjectionMeta {
  as_at: string;
  timezone: string;
  history_span_days: number;
  observed_days: number;
  level_daily: number;
  trend_weekly: number;
  has_day_of_week_factors: boolean;
  method: string;
}

export interface PaymentCollectionsProjection {
  currency: string;
  granularity: ProjectionGranularity;
  history: ProjectionHistoryPoint[];
  periods: ProjectionPeriod[];
  meta: ProjectionMeta;
}

export function usePaymentCollectionsProjection(
  granularity: ProjectionGranularity,
  periods: number,
  enabled = true,
) {
  return useQuery({
    queryKey: ['payment-collections-projection', granularity, periods],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<PaymentCollectionsProjection> => {
      const { data, error } = await (supabase.rpc as unknown as (
        name: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: unknown }>)('get_payment_collections_projection', {
        p_granularity: granularity,
        p_periods: periods,
      });
      if (error) throw error;
      return data as PaymentCollectionsProjection;
    },
  });
}
