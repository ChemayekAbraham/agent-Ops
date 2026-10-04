import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Tenant Operations — live analytics data layer.
 *
 * Everything here is read-only and comes from two SECURITY DEFINER RPCs that
 * aggregate data already in the system:
 *   • get_tenant_ops_geo_metrics  → one row per node at the requested level
 *   • get_tenant_ops_agent_360    → a single agent's full operational picture
 *
 * No values are hardcoded, mocked or cached beyond React Query's stale window.
 */

export type GeoLevel = 'district' | 'agent';

/**
 * Geographic hierarchy is derived from what the platform actually stores.
 * Districts are the only operationally meaningful level in the data, so the
 * drill-down is District → Agent. No artificial continent/country levels.
 */
export interface GeoPath {
  district?: string;
}

export function nextGeoLevel(p: GeoPath): GeoLevel {
  return p.district ? 'agent' : 'district';
}

export const GEO_LEVEL_LABEL: Record<GeoLevel, string> = {
  district: 'Districts',
  agent: 'Agents',
};

export interface GeoMetricsRow {
  key: string;
  label: string;
  agent_id: string | null;
  tenants_total: number;
  tenants_active: number;
  tenants_inactive: number;
  tenants_new_month: number;
  tenants_prev_month: number;
  /** Daily-cycle funnel. This product bills every active plan every calendar day. */
  billable_today: number;
  settled_today: number;
  partial_today: number;
  covered_by_advance: number;
  uncollected_today: number;
  expected_today: number;
  collected_today: number;
  overdue_count: number;
  arrears_count: number;
  /** Arrears ageing (Portfolio at Risk) in days behind the daily schedule. */
  par_current: number;
  par_1_7: number;
  par_8_30: number;
  par_31_60: number;
  par_60_plus: number;
  par_amount_30_plus: number;
  avg_days_behind: number;
  paid_early: number;
  paid_on_time: number;
  paid_late: number;
  paid_today: number;
  paid_week: number;
  paid_month: number;
  rent_expected_monthly: number;
  rent_collected_month: number;
  expected_to_date: number;
  collected_to_date: number;
  outstanding_total: number;
  overdue_amount: number;
  advance_amount: number;
  avg_rent: number;
  expiring_leases: number;
  ended_leases: number;
  properties_total: number;
  occupied_units: number;
  vacant_units: number;
  landlords_total: number;
  landlords_new: number;
  agents_total: number;
  agents_active: number;
  regions_count: number;
  districts_count: number;
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalise(row: any): GeoMetricsRow {
  return {
    key: String(row.key ?? ''),
    label: String(row.label ?? row.key ?? ''),
    agent_id: row.agent_id ?? null,
    tenants_total: num(row.tenants_total),
    tenants_active: num(row.tenants_active),
    tenants_inactive: num(row.tenants_inactive),
    tenants_new_month: num(row.tenants_new_month),
    tenants_prev_month: num(row.tenants_prev_month),
    billable_today: num(row.billable_today),
    settled_today: num(row.settled_today),
    partial_today: num(row.partial_today),
    covered_by_advance: num(row.covered_by_advance),
    uncollected_today: num(row.uncollected_today),
    expected_today: num(row.expected_today),
    collected_today: num(row.collected_today),
    overdue_count: num(row.overdue_count),
    arrears_count: num(row.arrears_count),
    par_current: num(row.par_current),
    par_1_7: num(row.par_1_7),
    par_8_30: num(row.par_8_30),
    par_31_60: num(row.par_31_60),
    par_60_plus: num(row.par_60_plus),
    par_amount_30_plus: num(row.par_amount_30_plus),
    avg_days_behind: num(row.avg_days_behind),
    paid_early: num(row.paid_early),
    paid_on_time: num(row.paid_on_time),
    paid_late: num(row.paid_late),
    paid_today: num(row.paid_today),
    paid_week: num(row.paid_week),
    paid_month: num(row.paid_month),
    rent_expected_monthly: num(row.rent_expected_monthly),
    rent_collected_month: num(row.rent_collected_month),
    expected_to_date: num(row.expected_to_date),
    collected_to_date: num(row.collected_to_date),
    outstanding_total: num(row.outstanding_total),
    overdue_amount: num(row.overdue_amount),
    advance_amount: num(row.advance_amount),
    avg_rent: num(row.avg_rent),
    expiring_leases: num(row.expiring_leases),
    ended_leases: num(row.ended_leases),
    properties_total: num(row.properties_total),
    occupied_units: num(row.occupied_units),
    vacant_units: num(row.vacant_units),
    landlords_total: num(row.landlords_total),
    landlords_new: num(row.landlords_new),
    agents_total: num(row.agents_total),
    agents_active: num(row.agents_active),
    regions_count: num(row.regions_count),
    districts_count: num(row.districts_count),
  };
}

export function useTenantOpsGeoMetrics(path: GeoPath) {
  const level = nextGeoLevel(path);
  return useQuery({
    queryKey: ['tenant-ops-geo-metrics', level, path.district],
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_tenant_ops_geo_metrics', {
        p_level: level,
        p_continent: null,
        p_country: null,
        p_region: null,
        p_district: path.district ?? null,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map(normalise);
    },
  });
}

/** Roll a set of node rows up into a single aggregate for the header KPI band. */
export function rollupGeoRows(rows: GeoMetricsRow[] | undefined): GeoMetricsRow {
  const base = normalise({ key: 'total', label: 'Total' });
  if (!rows?.length) return base;
  const summable: (keyof GeoMetricsRow)[] = [
    'tenants_total', 'tenants_active', 'tenants_inactive', 'tenants_new_month', 'tenants_prev_month',
    'billable_today', 'settled_today', 'partial_today', 'covered_by_advance', 'uncollected_today',
    'expected_today', 'collected_today', 'overdue_count', 'arrears_count',
    'par_current', 'par_1_7', 'par_8_30', 'par_31_60', 'par_60_plus', 'par_amount_30_plus',
    'paid_early', 'paid_on_time', 'paid_late', 'paid_today', 'paid_week', 'paid_month',
    'rent_expected_monthly', 'rent_collected_month', 'expected_to_date', 'collected_to_date',
    'outstanding_total', 'overdue_amount', 'advance_amount', 'expiring_leases', 'ended_leases',
    'properties_total', 'occupied_units', 'vacant_units', 'landlords_total', 'landlords_new',
    'agents_total', 'agents_active', 'regions_count', 'districts_count',
  ];
  const out: any = { ...base };
  for (const k of summable) out[k] = rows.reduce((s, r) => s + num(r[k]), 0);
  // Days-behind is an average, not a sum — weight it by the tenants it describes.
  const behind = rows.filter((r) => r.avg_days_behind > 0);
  out.avg_days_behind = behind.length
    ? behind.reduce((s, r) => s + r.avg_days_behind * Math.max(r.overdue_count, 1), 0) /
      Math.max(behind.reduce((s, r) => s + Math.max(r.overdue_count, 1), 0), 1)
    : 0;
  const rented = rows.filter((r) => r.avg_rent > 0);
  out.avg_rent = rented.length
    ? rented.reduce((s, r) => s + r.avg_rent * r.tenants_total, 0) /
      Math.max(rented.reduce((s, r) => s + r.tenants_total, 0), 1)
    : 0;
  return out as GeoMetricsRow;
}

/** Derived ratios — all traceable to the raw counters above. */
export function deriveRatios(r: GeoMetricsRow) {
  const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
  const units = r.occupied_units + r.vacant_units;
  return {
    collectionRate: pct(r.collected_to_date, r.expected_to_date),
    monthCollectionRate: pct(r.rent_collected_month, r.rent_expected_monthly),
    occupancyRate: pct(r.occupied_units, units),
    vacancyRate: pct(r.vacant_units, units),
    growthRate: r.tenants_prev_month > 0
      ? ((r.tenants_new_month - r.tenants_prev_month) / r.tenants_prev_month) * 100
      : r.tenants_new_month > 0 ? 100 : 0,
    arrearsRate: pct(r.arrears_count, r.tenants_active),
    /** Today's collection efficiency — the single number field ops is judged on. */
    dailyCollectionRate: pct(r.collected_today, r.expected_today),
    /** Share of today's billable book actually touched today (paid in full or part). */
    dailyContactRate: pct(r.settled_today + r.partial_today, r.billable_today),
    /** Share of the active book more than 30 days behind schedule. */
    par30Rate: pct(r.par_31_60 + r.par_60_plus, r.tenants_active),
    retentionRate: r.tenants_total > 0
      ? pct(r.tenants_total - r.ended_leases, r.tenants_total)
      : 0,
    activeRate: pct(r.tenants_active, r.tenants_total),
  };
}

export interface Agent360 {
  profile: any;
  tenants: Record<string, number>;
  financials: Record<string, number>;
  properties: Record<string, number>;
  landlords: Record<string, number>;
  collections: Record<string, number>;
  commissions: Record<string, number>;
  wallet: Record<string, number> | null;
  withdrawals: Record<string, number>;
  tenant_list: any[];
  landlord_list: any[];
  property_list: any[];
  collection_trend: { day: string; collected: number }[];
}

export function useTenantOpsAgent360(agentId: string | null) {
  return useQuery({
    enabled: !!agentId,
    queryKey: ['tenant-ops-agent-360', agentId],
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_tenant_ops_agent_360', {
        p_agent_id: agentId,
      });
      if (error) throw error;
      return data as Agent360;
    },
  });
}
