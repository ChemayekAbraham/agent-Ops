/**
 * Tenant Payment Behavior (self-payments vs agent payments). Thin readers over the
 * tops_payment_behaviour_* RPCs: every figure, percentage, estimate and flag is computed in SQL;
 * this file only fetches, types and caches. Nothing here writes anything.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface PaymentBehaviorFilters {
  startIso: string;
  endIso: string;
  agentId?: string | null;
  region?: string | null;
  district?: string | null;
  /** 'daily' | 'weekly' | null for all */
  cadence?: string | null;
}

const filterArgs = (f: PaymentBehaviorFilters) => ({
  p_start: f.startIso,
  p_end: f.endIso,
  p_agent_id: f.agentId ?? null,
  p_region: f.region ?? null,
  p_district: f.district ?? null,
  p_cadence: f.cadence ?? null,
});

const filterKey = (f: PaymentBehaviorFilters) => [f.startIso, f.endIso, f.agentId ?? null, f.region ?? null, f.district ?? null, f.cadence ?? null];

const ROOT = ['tenantOpsWorkspace', 'paymentBehavior'] as const;

// ─── Summary / overview ──────────────────────────────────────────────────────

export interface PaymentChannelStats {
  n: number;
  ugx: number;
  avg_ugx: number | null;
  median_ugx: number | null;
  tenants: number;
}

export interface SegmentCoverage {
  segment: 'self_only' | 'mixed' | 'agent_only' | 'no_payment';
  tenants: number;
  billed_ugx: number;
  covered_ugx: number;
  short_ugx: number;
  coverage_pct: number | null;
}

export interface PaymentBehaviorSummary {
  window: { start_day: string; end_day: string; asof: string; days: number };
  data_since: { first_self_payment_day: string | null; first_billed_day: string | null };
  basis: string;
  payments: {
    self: PaymentChannelStats;
    agent: PaymentChannelStats;
    other: PaymentChannelStats;
    total_n: number;
    total_ugx: number;
    self_share_pct: number | null;
    agent_share_pct: number | null;
    self_count_share_pct: number | null;
  };
  tenants: {
    billed: number;
    paying: number;
    self_payers: number;
    agent_paid: number;
    self_only: number;
    agent_only: number;
    mixed: number;
    billed_not_paying: number;
    self_payers_pct: number | null;
    self_only_pct: number | null;
    agent_only_pct: number | null;
    mixed_pct: number | null;
    previous: { paying: number; self_payers: number; self_payers_pct: number | null };
    self_payers_pct_change_pp: number | null;
  };
  coverage: {
    billed_ugx: number;
    covered_ugx: number;
    short_ugx: number;
    coverage_pct: number | null;
    by_segment: SegmentCoverage[];
  };
}

export type BehaviouralSegmentKey = 'self_reliant' | 'hybrid' | 'agent_led_some_self' | 'agent_dependent' | 'no_payment';

export interface BehaviouralSegmentRow {
  segment: BehaviouralSegmentKey;
  tenants: number;
  billed_ugx: number;
  covered_ugx: number;
  short_ugx: number;
  coverage_pct: number | null;
  self_ugx: number;
  agent_ugx: number;
  avg_paid_day_pct: number | null;
}

export type ShiftKey = 'moving_to_agents' | 'moving_to_self' | 'new_self_adopter';

export interface ShiftRow {
  shift: ShiftKey;
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string | null;
  agent_id: string | null;
  previous_self_share_pct: number | null;
  self_share_pct: number | null;
  self_ugx: number;
  agent_ugx: number;
}

export interface PaymentBehaviorOverview {
  summary: PaymentBehaviorSummary;
  segments: { definition: string; rows: BehaviouralSegmentRow[] };
  shift: {
    definition: string;
    previous_window: { start_day: string; end_day: string };
    counts: Partial<Record<ShiftKey, number>>;
    rows: ShiftRow[];
  };
  comparison: {
    definition: string;
    self_payers: { tenants: number; coverage_pct: number | null; paid_day_pct: number | null } | null;
    agent_only: { tenants: number; coverage_pct: number | null; paid_day_pct: number | null } | null;
    difference_pp: number | null;
    margin_pp_95: number | null;
    enough_data: boolean;
  };
  correlations: {
    definition: string;
    tenants_with_self_pay: number;
    enough_data: boolean;
    pairs: { key: string; label: string; r: number | null; n: number }[];
  };
}

export function usePaymentBehaviorOverview(f: PaymentBehaviorFilters) {
  return useQuery({
    queryKey: [...ROOT, 'overview', ...filterKey(f)],
    queryFn: async () => {
      const { data, error } = await anyDb.rpc('tops_payment_behaviour_overview', filterArgs(f));
      if (error) throw error;
      return data as PaymentBehaviorOverview;
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** Lighter read for the Tenant Ops Home card. */
export function usePaymentBehaviorSummary(f: PaymentBehaviorFilters, enabled = true) {
  return useQuery({
    queryKey: [...ROOT, 'summary', ...filterKey(f)],
    queryFn: async () => {
      const { data, error } = await anyDb.rpc('tops_payment_behaviour_summary', filterArgs(f));
      if (error) throw error;
      return data as PaymentBehaviorSummary;
    },
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

// ─── Trend ───────────────────────────────────────────────────────────────────

export interface TrendPoint {
  bucket_start: string;
  bucket_end: string;
  partial: boolean;
  self_ugx: number;
  agent_ugx: number;
  other_ugx: number;
  self_n: number;
  agent_n: number;
  self_tenants: number;
  agent_tenants: number;
  paying_tenants: number;
  self_share_pct: number | null;
  self_tenant_pct: number | null;
}

export type PaymentBehaviorProjection =
  | { available: false; weeks_used: number; reason: string }
  | {
      available: true;
      estimate: true;
      method: string;
      weeks_used: number;
      first_week: string;
      last_week: string;
      slope_pp_per_week: number;
      r_squared: number;
      confidence: 'low' | 'moderate';
      projected: { week_start: string; self_share_pct: number; self_ugx: number }[];
    };

export interface PaymentBehaviorTrend {
  bucket: 'day' | 'week' | 'month';
  window: { start_day: string; end_day: string; asof: string };
  points: TrendPoint[];
  projection: PaymentBehaviorProjection;
}

export function usePaymentBehaviorTrend(f: PaymentBehaviorFilters) {
  return useQuery({
    queryKey: [...ROOT, 'trend', ...filterKey(f)],
    queryFn: async () => {
      const { data, error } = await anyDb.rpc('tops_payment_behaviour_trend', filterArgs(f));
      if (error) throw error;
      return data as PaymentBehaviorTrend;
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

// ─── Timing, frequency, amounts ──────────────────────────────────────────────

export type LagBucketKey = 'ahead' | 'same_day' | 'late_1_3' | 'late_4_7' | 'late_8_14' | 'late_15_plus';

export interface ChannelOnTime {
  settled_ugx: number;
  settled_days: number;
  receipts: number;
  on_time_ugx: number;
  on_time_pct: number | null;
  late_pct: number | null;
  on_time_days_pct: number | null;
  avg_days_late_when_late: number | null;
  median_days_vs_due: number | null;
  buckets: { key: LagBucketKey; settled_ugx: number; settled_pct: number | null; settled_days: number; receipts: number }[];
}

export interface ChannelFrequency {
  tenants: number;
  avg_payments_per_tenant: number | null;
  avg_pay_days_per_tenant: number | null;
  gaps_measured: number;
  avg_days_between_payments: number | null;
  median_days_between_payments: number | null;
}

export interface ChannelAmounts {
  n: number;
  avg_ugx: number | null;
  p10: number | null;
  p25: number | null;
  median_ugx: number | null;
  p75: number | null;
  p90: number | null;
  max_ugx: number | null;
}

export interface PaymentBehaviorTiming {
  on_time: {
    definition: string;
    settlement_detail_since: string | null;
    receipts_in_window: number;
    receipts_with_detail: number;
    detail_coverage_pct: number | null;
    by_channel: { self: ChannelOnTime; agent: ChannelOnTime };
  };
  frequency: {
    definition: string;
    by_segment: { segment: string; plans: number; paid_day_pct: number | null; consistent: number; patchy: number; sporadic: number }[];
    by_channel: { self: ChannelFrequency; agent: ChannelFrequency };
  };
  amounts: { self?: ChannelAmounts; agent?: ChannelAmounts };
  clock: {
    median_hour: { self?: number | null; agent?: number | null } | null;
    hours: { self: number[]; agent: number[] };
    weekdays: { self: number[]; agent: number[] };
  };
}

export function usePaymentBehaviorTiming(f: PaymentBehaviorFilters) {
  return useQuery({
    queryKey: [...ROOT, 'timing', ...filterKey(f)],
    queryFn: async () => {
      const { data, error } = await anyDb.rpc('tops_payment_behaviour_timing', filterArgs(f));
      if (error) throw error;
      return data as PaymentBehaviorTiming;
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

// ─── Breakdown by dimension ──────────────────────────────────────────────────

export type PaymentBehaviorDimension = 'agent' | 'region' | 'district' | 'rent_band' | 'cadence' | 'cohort';

export interface DimensionRow {
  key: string;
  label: string;
  plans: number;
  billed_tenants: number;
  paying_tenants: number;
  self_payers: number;
  self_payers_pct: number | null;
  self_only: number;
  agent_only: number;
  mixed: number;
  self_ugx: number;
  agent_ugx: number;
  self_share_pct: number | null;
  billed_ugx: number;
  covered_ugx: number;
  short_ugx: number;
  coverage_pct: number | null;
  self_payers_coverage_pct: number | null;
  agent_only_coverage_pct: number | null;
}

export async function fetchPaymentBehaviorBy(f: PaymentBehaviorFilters, dimension: PaymentBehaviorDimension, limit = 300): Promise<DimensionRow[]> {
  const { data, error } = await anyDb.rpc('tops_payment_behaviour_by', { ...filterArgs(f), p_dimension: dimension, p_limit: limit });
  if (error) throw error;
  return ((data?.rows ?? []) as DimensionRow[]);
}

export function usePaymentBehaviorBy(f: PaymentBehaviorFilters, dimension: PaymentBehaviorDimension, enabled = true) {
  return useQuery({
    queryKey: [...ROOT, 'by', dimension, ...filterKey(f)],
    queryFn: () => fetchPaymentBehaviorBy(f, dimension),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

// ─── Early warning ───────────────────────────────────────────────────────────

export type WarningFlag = 'silent' | 'slipping' | 'behind' | 'moving_to_agent' | 'refused_attempt';

export interface WatchlistRow {
  rent_request_id: string;
  plan_code: string;
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string;
  agent_phone: string | null;
  region: string | null;
  district: string | null;
  cadence: string | null;
  rent_ugx: number | null;
  score: number;
  flags: WarningFlag[];
  days_since_payment: number | null;
  last_paid_day: string | null;
  median_gap_days: number | null;
  days_behind: number | null;
  billed_7d_ugx: number;
  paid_7d_ugx: number;
  billed_prev_7d_ugx: number;
  paid_prev_7d_ugx: number;
  self_paid_28d_ugx: number;
  agent_paid_28d_ugx: number;
}

export interface WatchlistBacktest {
  estimate: true;
  cutoff_day: string;
  outcome_window: { start_day: string; end_day: string };
  missed_definition: string;
  plans: number;
  missed: number;
  missed_pct: number | null;
  no_signs_plans: number;
  no_signs_missed_pct: number | null;
  two_plus_signs_plans: number;
  two_plus_signs_missed_pct: number | null;
  enough_data: boolean;
  by_score: { score: string; plans: number; missed: number; missed_pct: number | null }[];
  by_flag: { flag: WarningFlag; flagged_plans: number; flagged_missed_pct: number | null; unflagged_plans: number; unflagged_missed_pct: number | null }[];
}

export interface PaymentBehaviorWatchlist {
  asof: string;
  definition: string;
  summary: {
    plans_scored: number;
    score_0: number;
    score_1: number;
    score_2: number;
    score_3_plus: number;
    by_flag: Record<WarningFlag, number>;
  };
  total: number;
  rows: WatchlistRow[];
  backtest: WatchlistBacktest;
}

export interface WatchlistPaging {
  minScore: number;
  limit: number;
  offset: number;
}

export async function fetchPaymentBehaviorWatchlist(f: PaymentBehaviorFilters, paging: WatchlistPaging): Promise<PaymentBehaviorWatchlist> {
  const { data, error } = await anyDb.rpc('tops_payment_behaviour_watchlist', {
    ...filterArgs(f),
    p_min_score: paging.minScore,
    p_limit: paging.limit,
    p_offset: paging.offset,
  });
  if (error) throw error;
  return data as PaymentBehaviorWatchlist;
}

export function usePaymentBehaviorWatchlist(f: PaymentBehaviorFilters, paging: WatchlistPaging, enabled = true) {
  return useQuery({
    queryKey: [...ROOT, 'watchlist', paging.minScore, paging.limit, paging.offset, ...filterKey(f)],
    queryFn: () => fetchPaymentBehaviorWatchlist(f, paging),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

// ─── Filter options ──────────────────────────────────────────────────────────

export interface PaymentBehaviorOptions {
  agents: { id: string; name: string }[];
  regions: string[];
  districts: { region: string; district: string }[];
  cadences: string[];
}

export function usePaymentBehaviorOptions() {
  return useQuery({
    queryKey: [...ROOT, 'options'],
    queryFn: async () => {
      const { data, error } = await anyDb.rpc('tops_payment_behaviour_options');
      if (error) throw error;
      return data as PaymentBehaviorOptions;
    },
    staleTime: 10 * 60_000,
  });
}

/** Everything the PDF report needs, in one parallel fetch (same RPCs, same filters as the screen). */
export async function fetchPaymentBehaviorReportData(f: PaymentBehaviorFilters) {
  const rpc = async <T,>(fn: string, extra: Record<string, unknown> = {}): Promise<T> => {
    const { data, error } = await anyDb.rpc(fn, { ...filterArgs(f), ...extra });
    if (error) throw error;
    return data as T;
  };
  const [overview, trend, timing, agents, regions, districts, rentBands, cadences, cohorts, watchlist] = await Promise.all([
    rpc<PaymentBehaviorOverview>('tops_payment_behaviour_overview'),
    rpc<PaymentBehaviorTrend>('tops_payment_behaviour_trend'),
    rpc<PaymentBehaviorTiming>('tops_payment_behaviour_timing'),
    fetchPaymentBehaviorBy(f, 'agent'),
    fetchPaymentBehaviorBy(f, 'region'),
    fetchPaymentBehaviorBy(f, 'district'),
    fetchPaymentBehaviorBy(f, 'rent_band'),
    fetchPaymentBehaviorBy(f, 'cadence'),
    fetchPaymentBehaviorBy(f, 'cohort'),
    fetchPaymentBehaviorWatchlist(f, { minScore: 2, limit: 25, offset: 0 }),
  ]);
  return { overview, trend, timing, byDimension: { agent: agents, region: regions, district: districts, rent_band: rentBands, cadence: cadences, cohort: cohorts }, watchlist };
}

export type PaymentBehaviorReportData = Awaited<ReturnType<typeof fetchPaymentBehaviorReportData>>;
