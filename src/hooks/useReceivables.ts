import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Single source of truth for receivables in the product.
 *
 * Every figure below comes from the server-side authoritative definition
 * (`v_receivables_lines`) through `get_receivables_total`,
 * `get_receivables_breakdown` and `get_receivables_forecast`.
 * Do NOT re-implement receivables maths in JS — add it to the view instead.
 */

const STALE_TIME = 5 * 60 * 1000;

export interface ReceivablesCategoryTotal {
  key: string;
  label: string;
  outstanding: number;
  item_count: number;
}

export interface ReceivablesTotal {
  currency: string;
  as_at: string;
  total: number;
  item_count: number;
  categories: ReceivablesCategoryTotal[];
  source: string;
}

export interface ReceivableItem {
  item_id: string;
  counterparty: string | null;
  amount: number;
  due_date: string | null;
  due_kind: 'scheduled' | 'projected';
  status: string | null;
  source: string;
}

export interface ReceivableProduct {
  key: string;
  label: string;
  source: string;
  outstanding: number;
  item_count: number;
  scheduled_amount: number;
  projected_amount: number;
  items: ReceivableItem[];
}

export interface ReceivablesBreakdownCategory {
  key: string;
  label: string;
  outstanding: number;
  item_count: number;
  products: ReceivableProduct[];
}

export interface ReceivablesBreakdown {
  currency: string;
  as_at: string;
  total: number;
  categories: ReceivablesBreakdownCategory[];
  validation: {
    categories_total: number;
    authoritative_total: number;
    difference: number;
    ties_out: boolean;
  };
  source: string;
}

export interface ReceivablesForecast {
  currency: string;
  today: string;
  range: { from: string; to: string };
  scheduled_total: number;
  projected_total: number;
  range_total: number;
  unscheduled_outstanding: number;
  days: Array<{ date: string; scheduled: number; projected: number; total: number }>;
  products: Array<{
    category_key: string;
    category_label: string;
    product_key: string;
    product_label: string;
    scheduled: number;
    projected: number;
    total: number;
  }>;
  projection_basis: {
    lookback_days: number;
    agent_collections: { sample_days: number; median_daily: number };
    business_advance_repayments: { sample_days: number; median_daily: number };
    credit_draw_ledger: { sample_days: number; median_daily: number };
  };
  source: string;
}

/** Authoritative Total Receivables + per-category totals. */
export function useReceivablesTotal() {
  return useQuery({
    queryKey: ['receivables-total'],
    queryFn: async (): Promise<ReceivablesTotal> => {
      const { data, error } = await supabase.rpc('get_receivables_total');
      if (error) throw error;
      return data as unknown as ReceivablesTotal;
    },
    staleTime: STALE_TIME,
  });
}

/** Category → product → item drill-down, with the tie-out validation block. */
export function useReceivablesBreakdown(enabled = true) {
  return useQuery({
    queryKey: ['receivables-breakdown'],
    enabled,
    queryFn: async (): Promise<ReceivablesBreakdown> => {
      const { data, error } = await supabase.rpc('get_receivables_breakdown');
      if (error) throw error;
      return data as unknown as ReceivablesBreakdown;
    },
    staleTime: STALE_TIME,
  });
}

/** Forecast for an explicit date window. Scheduled = exact dates, projected = estimated. */
export function useReceivablesForecast(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ['receivables-forecast', from, to],
    enabled: enabled && !!from && !!to,
    queryFn: async (): Promise<ReceivablesForecast> => {
      const { data, error } = await supabase.rpc('get_receivables_forecast', {
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      return data as unknown as ReceivablesForecast;
    },
    staleTime: STALE_TIME,
  });
}

/* ---------- Predictive forecast (data-driven, modelled from real history) ---------- */

export type ForecastGranularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface PredictiveSource {
  category_key: string;
  category_label: string;
  product_key: string;
  product_label: string;
  amount: number;
  runoff: number;
  new_origination: number;
  basis: 'modelled' | 'scheduled';
}

export interface PredictivePeriod {
  index: number;
  period_start: string;
  period_end: string;
  forecast_from: string;
  is_partial_period: boolean;
  label: string;
  forecast_amount: number;
  runoff_amount: number;
  new_origination_amount: number;
  scheduled_amount: number;
  low: number;
  high: number;
  confidence: number;
  quality: 'high' | 'medium' | 'low' | 'insufficient';
  quality_reason: string;
  is_forecast: true;
  sources: PredictiveSource[];
}

export interface PredictiveOriginationModel {
  method: string;
  sample_days: number;
  daily_new_receivables: number;
  trend_per_week: number;
  collection_rate: number;
  term_days: number;
}


export interface PredictiveForecast {
  currency: string;
  granularity: ForecastGranularity;
  periods_requested: number;
  as_at: string;
  timezone: string;
  actual: {
    total: number;
    item_count: number;
    overdue: number;
    not_yet_due: number;
    categories: { category_key: string; category_label: string; outstanding: number }[];
  };
  history: { period_start: string; label: string; actual_amount: number; is_forecast: false }[];
  periods: PredictivePeriod[];
  streams: {
    category_key: string;
    category_label: string;
    product_key: string;
    product_label: string;
    method: string;
    sample_days: number;
    lookback_days: number;
    median_daily: number;
    trend_per_week: number;
    backtest_mape: number | null;
    seasonality_applied: boolean;
    insufficient_data: boolean;
    outstanding: number;
    origination: PredictiveOriginationModel | null;
  }[];
  scheduled_only_streams: {
    category_key: string;
    product_key: string;
    product_label: string;
    outstanding: number;
    reason: string;
  }[];
  origination_only_streams: {
    category_key: string;
    product_key: string;
    product_label: string;
    outstanding: number;
    reason: string;
  }[];
  meta: {
    history_span_days: number | null;
    lookback_days: number;
    method_note: string;
    source: string;
  };
}

/**
 * Server-side predictive receivables forecast. Models each business line from its own
 * observed collection history; never hardcoded percentages.
 */
export function useReceivablesPredictiveForecast(
  granularity: ForecastGranularity,
  periods: number,
  enabled = true
) {
  return useQuery({
    queryKey: ['receivables-predictive-forecast', granularity, periods],
    enabled,
    queryFn: async (): Promise<PredictiveForecast> => {
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'get_receivables_predictive_forecast',
        { p_granularity: granularity, p_periods: periods }
      );
      if (error) throw error;
      return data as PredictiveForecast;
    },
    staleTime: STALE_TIME,
  });
}
