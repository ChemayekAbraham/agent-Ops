import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Single source of truth for payables (what the company owes).
 *
 * Every figure comes from the server-side authoritative definition
 * (`v_payables_lines`) through `get_payables_total`, `get_payables_breakdown`,
 * `get_payables_predictive_forecast` and `get_payables_forecast_accuracy`.
 * Do NOT re-implement payables maths in JS — extend the view instead.
 */

const STALE_TIME = 5 * 60 * 1000;

type RpcFn = (
  fn: string,
  args?: Record<string, unknown>
) => Promise<{ data: unknown; error: { message: string } | null }>;

/**
 * Call the payables RPCs through the client instance.
 *
 * IMPORTANT: do NOT detach the method (`const rpc = supabase.rpc as RpcFn`).
 * `PostgrestClient.rpc` relies on `this`, so an unbound reference throws
 * "Cannot read properties of undefined (reading 'rest')" before any request is
 * sent — which is exactly why the CFO payables cards silently showed UGX 0.
 */
const rpc: RpcFn = (fn, args) =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => Promise<{
    data: unknown;
    error: { message: string } | null;
  }>).call(supabase, fn, args);


export interface PayablesCategoryTotal {
  key: string;
  label: string;
  outstanding: number;
  item_count: number;
}

export interface PayablesTotal {
  currency: string;
  as_at: string;
  total: number;
  item_count: number;
  overdue: number;
  due_today: number;
  categories: PayablesCategoryTotal[];
  source: string;
}

export interface PayableItem {
  item_id: string;
  counterparty: string | null;
  amount: number;
  due_date: string | null;
  due_kind: 'scheduled' | 'projected';
  status: string | null;
  source: string;
}

export interface PayableProduct {
  key: string;
  label: string;
  source: string;
  outstanding: number;
  item_count: number;
  scheduled_amount: number;
  projected_amount: number;
  items: PayableItem[];
}

export interface PayablesBreakdownCategory {
  key: string;
  label: string;
  outstanding: number;
  item_count: number;
  products: PayableProduct[];
}

export interface PayablesBreakdown {
  currency: string;
  as_at: string;
  total: number;
  categories: PayablesBreakdownCategory[];
  validation: {
    categories_total: number;
    authoritative_total: number;
    difference: number;
    ties_out: boolean;
  };
  source: string;
}

export type PayablesGranularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface PayablesPredictiveSource {
  category_key: string;
  category_label: string;
  product_key: string;
  product_label: string;
  amount: number;
  runoff: number;
  new_origination: number;
  basis: 'modelled' | 'scheduled';
}

export interface PayablesPredictivePeriod {
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
  sources: PayablesPredictiveSource[];
}

export interface PayablesObligationModel {
  method: string;
  sample_days: number;
  daily_new_payables: number;
  trend_per_week: number;
  payment_rate: number;
  term_days: number;
}

export interface PayablesPredictiveForecast {
  currency: string;
  granularity: PayablesGranularity;
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
  periods: PayablesPredictivePeriod[];
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
    origination: PayablesObligationModel | null;
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
    model_version: string;
    method_note: string;
    source: string;
  };
  /**
   * Obligations with no contractual due date and no daily amount — wallet
   * balances are payable on demand, so there is nothing to place on a timeline.
   * Still part of Total Payables; excluded only from the forecast.
   */
  unscheduled?: {
    items: number;
    amount: number;
    by_product: Record<string, number>;
    note?: string;
  };
}

export interface PayablesAccuracyHorizon {
  horizon_days: number;
  runs: number;
  accuracy_pct: number | null;
  mape_pct: number | null;
  bias_pct: number | null;
  band_hit_pct: number | null;
  total_forecast: number;
  total_actual: number;
}

export interface PayablesForecastAccuracy {
  currency: string;
  as_at: string;
  timezone: string;
  horizons: PayablesAccuracyHorizon[];
  series: {
    origin: string;
    horizon_days: number;
    window_from: string;
    window_to: string;
    forecast: number;
    actual: number;
    low: number;
    high: number;
    error_pct: number | null;
    in_band: boolean;
  }[];
  products: {
    category_key: string;
    category_label: string;
    product_key: string;
    product_label: string;
    horizon_days: number;
    runs: number;
    accuracy_pct: number | null;
    mape_pct: number | null;
    bias_pct: number | null;
    total_forecast: number;
    total_actual: number;
  }[];
  meta: {
    origins_requested: number;
    origins_used: number;
    step_days: number;
    horizon_days: number[];
    first_history_date: string | null;
    model_version: string;
    method_note: string;
    source: string;
  };
}

/**
 * Authoritative Total Payables + per-category totals, overdue and due-today.
 *
 * `refetchOnMount: 'always'` matters here: without it a query that errored
 * earlier in the session (e.g. a transient auth/network failure) stays in an
 * error state with `data === undefined`, and the CFO card silently renders
 * UGX 0 instead of the real figure. The card must never fall back to zero, so
 * the freshness of this query is part of its correctness.
 */
export function usePayablesTotal() {
  return useQuery({
    queryKey: ['payables-total'],
    queryFn: async (): Promise<PayablesTotal> => {
      const { data, error } = await rpc('get_payables_total');
      if (error) throw error;
      return data as PayablesTotal;
    },

    staleTime: STALE_TIME,
    refetchOnMount: 'always',
    networkMode: 'always',
    retry: 2,
  });
}


/** Category → product → item drill-down, with the tie-out validation block. */
export function usePayablesBreakdown(enabled = true) {
  return useQuery({
    queryKey: ['payables-breakdown'],
    enabled,
    queryFn: async (): Promise<PayablesBreakdown> => {
      const { data, error } = await rpc('get_payables_breakdown');
      if (error) throw error;
      return data as PayablesBreakdown;
    },
    staleTime: STALE_TIME,
  });
}

/**
 * Server-side predictive payables forecast. Models each payable line from its own
 * observed payment and obligation history; never hardcoded percentages.
 */
export function usePayablesPredictiveForecast(
  granularity: PayablesGranularity,
  periods: number,
  enabled = true
) {
  return useQuery({
    queryKey: ['payables-predictive-forecast', granularity, periods],
    enabled,
    queryFn: async (): Promise<PayablesPredictiveForecast> => {
      const { data, error } = await rpc('get_payables_predictive_forecast', {
        p_granularity: granularity,
        p_periods: periods,
      });
      if (error) throw error;
      return data as PayablesPredictiveForecast;
    },
    staleTime: STALE_TIME,
  });
}

export interface PayablesContractPeriod {
  index: number;
  period_start: string;
  contract_amount: number;
  overdue_included: number;
}

/** Contractual (ideal) schedule from due dates of every open obligation; overdue lands in period 0. */
export function usePayablesContractSchedule(granularity: PayablesGranularity, periods: number, enabled = true) {
  return useQuery({
    queryKey: ['payables-contract-schedule', granularity, periods],
    enabled,
    queryFn: async (): Promise<PayablesContractPeriod[]> => {
      const { data, error } = await rpc('get_payables_contract_schedule', {
        p_granularity: granularity,
        p_periods: periods,
      });
      if (error) throw error;
      return (data ?? []) as PayablesContractPeriod[];
    },
    staleTime: STALE_TIME,
  });
}

/**
 * Walk-forward back-test: replays the live payables model at past origin dates
 * and grades it against what was actually paid.
 */
export function usePayablesForecastAccuracy(
  origins = 8,
  stepDays = 7,
  horizons: number[] = [1, 7, 30],
  enabled = true
) {
  return useQuery({
    queryKey: ['payables-forecast-accuracy', origins, stepDays, horizons.join(',')],
    enabled,
    queryFn: async (): Promise<PayablesForecastAccuracy> => {
      const { data, error } = await rpc('get_payables_forecast_accuracy', {
        p_origins: origins,
        p_step_days: stepDays,
        p_horizons: horizons,
      });
      if (error) throw error;
      return data as PayablesForecastAccuracy;
    },
    staleTime: STALE_TIME,
  });
}
