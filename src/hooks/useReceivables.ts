import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  /**
   * Receivables that cannot responsibly be placed in a forecast window: no
   * contractual date and no daily amount to project from. Still part of Total
   * Receivables — excluded only from the timeline, never from the book.
   */
  unscheduled?: {
    items: number;
    amount: number;
    by_product: Record<string, number>;
    note?: string;
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

/* ---------------------------------------------------------------------------
 * Forecast accuracy: walk-forward back-test + issued-forecast track record
 * ------------------------------------------------------------------------- */

export interface ForecastAccuracyHorizon {
  horizon_days: number;
  runs: number;
  accuracy_pct: number | null;
  mape_pct: number | null;
  bias_pct: number | null;
  band_hit_pct: number | null;
  total_forecast: number;
  total_actual: number;
}

export interface ForecastAccuracyRun {
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
}

export interface ForecastAccuracyProduct {
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
}

export interface ForecastAccuracy {
  currency: string;
  as_at: string;
  timezone: string;
  horizons: ForecastAccuracyHorizon[];
  series: ForecastAccuracyRun[];
  products: ForecastAccuracyProduct[];
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

export interface ForecastSnapshotRow {
  granularity: string;
  issued_on: string;
  period_start: string;
  period_end: string;
  horizon_days: number;
  quality: string | null;
  confidence: number | null;
  forecast: number;
  modelled_forecast: number;
  low: number;
  high: number;
  actual: number | null;
  graded_at: string | null;
  error_pct: number | null;
  abs_error: number | null;
  in_band: boolean | null;
}

export interface ForecastSnapshotAccuracy {
  currency: string;
  as_at: string;
  granularity: string | null;
  summary: {
    snapshots: number;
    graded: number;
    pending: number;
    accuracy_pct: number | null;
    mape_pct: number | null;
    bias_pct: number | null;
    band_hit_pct: number | null;
    first_snapshot: string | null;
  };
  rows: ForecastSnapshotRow[];
  meta: { method_note: string; source: string };
}

type RpcFn = (
  fn: string,
  args?: Record<string, unknown>
) => Promise<{ data: unknown; error: { message: string } | null }>;

/**
 * Walk-forward back-test: replays the live forecasting model at past origin dates
 * (it only sees data available then) and grades it against actual collections.
 */
export function useReceivablesForecastAccuracy(
  origins = 12,
  stepDays = 7,
  horizons: number[] = [1, 7, 30],
  enabled = true
) {
  return useQuery({
    queryKey: ['receivables-forecast-accuracy', origins, stepDays, horizons.join(',')],
    enabled,
    queryFn: async (): Promise<ForecastAccuracy> => {
      const { data, error } = await (supabase.rpc as unknown as RpcFn)(
        'get_receivables_forecast_accuracy',
        { p_origins: origins, p_step_days: stepDays, p_horizons: horizons }
      );
      if (error) throw error;
      return data as ForecastAccuracy;
    },
    staleTime: STALE_TIME,
  });
}

/** Issued-forecast track record: forecasts stored the day they were published, graded after close. */
export function useReceivablesForecastTrackRecord(
  granularity: string | null = null,
  limit = 60,
  enabled = true
) {
  return useQuery({
    queryKey: ['receivables-forecast-track-record', granularity, limit],
    enabled,
    queryFn: async (): Promise<ForecastSnapshotAccuracy> => {
      const { data, error } = await (supabase.rpc as unknown as RpcFn)(
        'get_receivables_forecast_snapshot_accuracy',
        { p_granularity: granularity, p_limit: limit }
      );
      if (error) throw error;
      return data as ForecastSnapshotAccuracy;
    },
    staleTime: STALE_TIME,
  });
}

/** Records today's published forecast so it can be graded later. Idempotent per day. */
export function useRecordForecastSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { granularity?: string; periods?: number }) => {
      const { data, error } = await (supabase.rpc as unknown as RpcFn)(
        'record_receivables_forecast_snapshot',
        { p_granularity: args.granularity ?? 'month', p_periods: args.periods ?? 6 }
      );
      if (error) throw error;
      return data as { granularity: string; as_at: string; periods_recorded: number };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['receivables-forecast-track-record'] });
    },
  });
}

/* ---------------------------------------------------------------------------
 * Tenant Products & Services: where the money is owed (approved Uganda
 * location hierarchy — region -> district -> town/subcounty -> village), and
 * the deeper drilldown to the exact tenant accounts and the cash-in/cash-out
 * or booking movements that build each balance. All read-only.
 * ------------------------------------------------------------------------- */

export type TenantReceivablesLevel = 'region' | 'district' | 'subcounty' | 'village';

export interface TenantReceivablesLocationProduct {
  key: string;
  label: string;
  outstanding: number;
  item_count: number;
}

export interface TenantReceivablesLocationItem {
  item_id: string;
  tenant: string | null;
  product: string;
  amount: number;
  status: string | null;
  village: string | null;
  town: string | null;
  district: string | null;
}

export interface TenantReceivablesLocationRow {
  key?: string;
  label: string;
  region: string | null;
  district: string | null;
  district_id: number | null;
  subcounty_id: number | null;
  outstanding: number;
  item_count: number;
  tenant_count: number;
  scheduled_amount: number;
  projected_amount: number;
  fully_mapped: boolean;
  products: TenantReceivablesLocationProduct[];
  top_items: TenantReceivablesLocationItem[];
}

export interface TenantReceivablesLocationBreakdown {
  currency: string;
  as_at: string;
  level: TenantReceivablesLevel;
  total: number;
  item_count: number;
  tenant_count: number;
  located_amount?: number;
  unmapped_amount?: number;
  products: TenantReceivablesLocationProduct[];
  rows: TenantReceivablesLocationRow[];
  source: string;
}

export interface TenantReceivablesLocationFilters {
  level: TenantReceivablesLevel;
  region?: string | null;
  districtId?: number | null;
  subcountyId?: number | null;
  productKey?: string | null;
}

/** Tenant receivables grouped by the approved Uganda location hierarchy. */
export function useTenantReceivablesByLocation(
  filters: TenantReceivablesLocationFilters,
  enabled = true
) {
  const { level, region = null, districtId = null, subcountyId = null, productKey = null } = filters;
  return useQuery({
    queryKey: ['tenant-receivables-location', level, region, districtId, subcountyId, productKey],
    enabled,
    queryFn: async (): Promise<TenantReceivablesLocationBreakdown> => {
      const { data, error } = await (supabase.rpc as unknown as RpcFn)(
        'get_tenant_receivables_location_breakdown',
        {
          p_level: level,
          p_region: region,
          p_district_id: districtId,
          p_subcounty_id: subcountyId,
          p_product_key: productKey,
        }
      );
      if (error) throw error;
      return data as TenantReceivablesLocationBreakdown;
    },
    staleTime: STALE_TIME,
  });
}

export interface TenantReceivableAccountItem {
  item_id: string;
  product: string;
  product_key: string;
  amount: number;
  status: string | null;
  due_date: string | null;
  due_kind: string | null;
}

export interface TenantReceivableAccount {
  tenant_id: string;
  tenant: string | null;
  phone: string | null;
  region: string | null;
  district: string | null;
  town: string | null;
  subcounty: string | null;
  village: string | null;
  outstanding: number;
  item_count: number;
  scheduled_amount: number;
  projected_amount: number;
  next_due_date: string | null;
  items: TenantReceivableAccountItem[];
}

export interface TenantReceivablesAccounts {
  currency: string;
  as_at: string;
  level: TenantReceivablesLevel;
  group_label: string | null;
  total: number;
  tenant_count: number;
  item_count: number;
  returned: number;
  accounts: TenantReceivableAccount[];
  source: string;
}

/** The exact tenant accounts owing inside one region / district / town / village. */
export function useTenantReceivableAccounts(
  filters: TenantReceivablesLocationFilters & { groupLabel?: string | null; limit?: number },
  enabled = true
) {
  const {
    level,
    region = null,
    districtId = null,
    subcountyId = null,
    productKey = null,
    groupLabel = null,
    limit = 200,
  } = filters;
  return useQuery({
    queryKey: [
      'tenant-receivables-accounts',
      level, region, districtId, subcountyId, productKey, groupLabel, limit,
    ],
    enabled,
    queryFn: async (): Promise<TenantReceivablesAccounts> => {
      const { data, error } = await (supabase.rpc as unknown as RpcFn)(
        'get_tenant_receivables_location_accounts',
        {
          p_level: level,
          p_region: region,
          p_district_id: districtId,
          p_subcounty_id: subcountyId,
          p_group_label: groupLabel,
          p_product_key: productKey,
          p_limit: limit,
        }
      );
      if (error) throw error;
      return data as TenantReceivablesAccounts;
    },
    staleTime: STALE_TIME,
  });
}

export interface TenantAccountMovements {
  currency: string;
  as_at: string;
  tenant_id: string;
  tenant: string | null;
  phone: string | null;
  outstanding: number;
  open_items: Array<{
    item_id: string;
    product: string;
    amount: number;
    due_date: string | null;
    due_kind: string | null;
    status: string | null;
    source_table: string | null;
  }>;
  bookings: Array<{
    rent_request_id: string;
    status: string | null;
    rent_amount: number | null;
    total_repayment: number | null;
    amount_repaid: number;
    outstanding: number;
    daily_repayment: number | null;
    duration_days: number | null;
    created_at: string | null;
    disbursed_at: string | null;
    schedule_status: string | null;
  }>;
  field_receipts: Array<{
    collection_id: string;
    amount: number;
    created_at: string;
    payment_method: string | null;
    rent_request_id: string | null;
    tracking_id: string | null;
    is_partial: boolean | null;
    agent: string | null;
  }>;
  ledger_movements: Array<{
    entry_id: string;
    transaction_date: string;
    direction: string;
    amount: number;
    category: string | null;
    description: string | null;
    ledger_scope: string | null;
    classification: string | null;
    reference_id: string | null;
    rent_request_id: string | null;
  }>;
  totals: {
    field_receipts_total: number;
    ledger_cash_in: number;
    ledger_cash_out: number;
    booked_total: number;
    repaid_total: number;
  };
  source: string;
}

/** One tenant account: the bookings, field receipts and cash-in/cash-out legs behind the balance. */
export function useTenantAccountMovements(tenantId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['tenant-receivable-account-movements', tenantId],
    enabled: enabled && !!tenantId,
    queryFn: async (): Promise<TenantAccountMovements> => {
      const { data, error } = await (supabase.rpc as unknown as RpcFn)(
        'get_tenant_receivable_account_movements',
        { p_tenant_id: tenantId, p_limit: 150 }
      );
      if (error) throw error;
      return data as TenantAccountMovements;
    },
    staleTime: 60 * 1000,
  });
}
