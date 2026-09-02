import { useQueries, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Proxy Agent Performance Value (PV) data layer.
 *
 * PV = (Verified commitments × note reward) + (New partner investments × 2%)
 *      + (Partner top-ups × 1%)
 *
 * Every figure comes from the server-side aggregates `get_proxy_agent_pv`
 * (individual, self-gated) and `partner_ops_proxy_agent_pv` (team view, gated
 * to proxy-directory viewers). No client-side money math.
 */

export interface ProxyPvDay {
  day: string;
  commitments: number;
  new_investment: number;
  topups: number;
  commitment_pv: number;
  investment_pv: number;
  topup_pv: number;
  total_pv: number;
  daily_target: number;
  performance_pct: number;
  is_working_day: boolean;
}

export interface ProxyPvReport {
  agent_id: string;
  agent_name: string;
  period_month: string;
  generated_at: string;
  rates: { commitment_pv: number; investment_pct: number; topup_pct: number };
  targets: {
    monthly_pv_target: number;
    working_days: number;
    daily_pv_target: number;
    working_days_elapsed: number;
    working_days_remaining: number;
    expected_mtd_pv: number;
  };
  today: {
    date: string;
    /** False on rest days (Sunday) — daily target is zero then. */
    is_working_day?: boolean;
    commitments: number;

    new_investment: number;
    topups: number;
    commitment_pv: number;
    investment_pv: number;
    topup_pv: number;
    total_pv: number;
    target_pv: number;
    performance_pct: number;
  };
  mtd: {
    commitments: number;
    new_investment: number;
    topups: number;
    commitment_pv: number;
    investment_pv: number;
    topup_pv: number;
    total_pv: number;
    expected_pv: number;
    performance_pct: number;
    monthly_performance_pct: number;
    remaining_to_target: number;
    above_target: number;
  };
  daily: ProxyPvDay[];
  /**
   * Server-computed data-quality signals for empty / attribution states.
   * Missing on responses cached before the block was added — treat as unknown.
   */
  data_quality?: {
    is_approved_proxy: boolean;
    /** This month's commitments not yet verified/activated — not counted in PV. */
    pending_commitments: number;
    /** This month's investment/top-up commission events not yet paid — not counted in PV. */
    unpaid_commission_events: number;
  };
}

export interface ProxyPvTeamRow {
  agent_user_id: string;
  name: string;
  status: string | null;
  avatar_url: string | null;
  phone: string | null;
  commitments: number;
  commitment_pv: number;
  new_investment: number;
  investment_pv: number;
  topups: number;
  topup_pv: number;
  total_pv: number;
  expected_pv: number;
  performance_pct: number;
  monthly_performance_pct: number;
}

export interface ProxyPvTeamResult {
  period_month: string;
  total: number;
  limit: number;
  offset: number;
  kpis: {
    agents_total: number;
    team_total_pv: number;
    team_new_investment: number;
    team_topups: number;
    team_commitments: number;
    team_commitment_pv: number;
    team_investment_pv: number;
    team_topup_pv: number;
    expected_mtd_pv: number;
    monthly_pv_target: number;
    working_days: number;
    working_days_elapsed: number;
    working_days_remaining: number;
    daily_pv_target: number;
    at_or_above_target: number;
    below_target: number;
    period_month: string;
  };
  rows: ProxyPvTeamRow[];
}

export type ProxyPvSort = 'total_pv' | 'commitments' | 'new_investment' | 'topups' | 'performance_pct' | 'name';

/** Performance bands used across both the agent and ops views. */
export type ProxyPvBand = 'on_track' | 'near' | 'lagging' | 'critical';

export function proxyPvBand(pct: number): ProxyPvBand {
  if (pct >= 100) return 'on_track';
  if (pct >= 80) return 'near';
  if (pct >= 50) return 'lagging';
  return 'critical';
}

export const PROXY_PV_BAND_META: Record<ProxyPvBand, { label: string; className: string; dot: string }> = {
  on_track: { label: 'Ahead', className: 'bg-success/10 text-success border-success/30', dot: 'bg-success' },
  near: { label: 'Near', className: 'bg-primary/10 text-primary border-primary/30', dot: 'bg-primary' },
  lagging: { label: 'Below', className: 'bg-warning/10 text-warning border-warning/30', dot: 'bg-warning' },
  critical: { label: 'Significantly Below', className: 'bg-destructive/10 text-destructive border-destructive/30', dot: 'bg-destructive' },
};

/** First day of the month, as the RPCs expect it. */
export function monthStartISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export function useProxyAgentPv(agentId?: string | null, month?: string) {
  return useQuery({
    queryKey: ['proxy-agent-pv', agentId ?? 'self', month ?? 'current'],
    enabled: agentId !== undefined,
    staleTime: 60_000,
    queryFn: async (): Promise<ProxyPvReport> => {
      const { data, error } = await supabase.rpc('get_proxy_agent_pv', {
        p_agent_id: agentId ?? null,
        p_month: month ?? null,
      });
      if (error) throw new Error(error.message);
      return data as unknown as ProxyPvReport;
    },
  });
}

/** ISO month starts for the last `count` months, newest first. */
export function recentMonths(count: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(monthStartISO(d));
  }
  return out;
}

export interface ProxyPvMonthPoint {
  month: string;
  label: string;
  total_pv: number;
  monthly_target: number;
  monthly_performance_pct: number;
}

/**
 * Monthly PV totals across the last `count` months for trend charts.
 * One cached `get_proxy_agent_pv` call per month; failed months are skipped.
 */
export function useProxyAgentPvMonthly(agentId: string | null, count = 6) {
  const months = recentMonths(count);
  const queries = useQueries({
    queries: months.map((m) => ({
      queryKey: ['proxy-agent-pv', agentId ?? 'self', m],
      staleTime: 60_000,
      queryFn: async (): Promise<ProxyPvReport> => {
        const { data, error } = await supabase.rpc('get_proxy_agent_pv', {
          p_agent_id: agentId ?? null,
          p_month: m,
        });
        if (error) throw new Error(error.message);
        return data as unknown as ProxyPvReport;
      },
    })),
  });

  const isLoading = queries.some((q) => q.isLoading);
  const points: ProxyPvMonthPoint[] = queries
    .map((q, i) => {
      const r = q.data;
      if (!r) return null;
      return {
        month: months[i],
        label: new Date(`${months[i]}T00:00:00`).toLocaleDateString('en-GB', { month: 'short' }),
        total_pv: r.mtd.total_pv,
        monthly_target: r.targets.monthly_pv_target,
        monthly_performance_pct: r.mtd.monthly_performance_pct,
      } satisfies ProxyPvMonthPoint;
    })
    .filter((p): p is ProxyPvMonthPoint => p !== null)
    .reverse(); // oldest → newest for charts

  return { isLoading, points };
}

export function useProxyTeamPv(params: {
  month?: string;
  search?: string;
  sort?: ProxyPvSort;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  enabled?: boolean;
}) {
  const { month, search = '', sort = 'total_pv', dir = 'desc', page = 0, pageSize = 25, enabled = true } = params;
  return useQuery({
    queryKey: ['proxy-team-pv', month ?? 'current', search, sort, dir, page, pageSize],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<ProxyPvTeamResult> => {
      const { data, error } = await supabase.rpc('partner_ops_proxy_agent_pv', {
        p_month: month ?? null,
        p_search: search.trim() || null,
        p_sort: sort,
        p_dir: dir,
        p_limit: pageSize,
        p_offset: page * pageSize,
      });
      if (error) throw new Error(error.message);
      return data as unknown as ProxyPvTeamResult;
    },
  });
}

export type ProxyPvActivityKind = 'commitments' | 'investment' | 'topups';

export interface ProxyPvActivityItem {
  id: string;
  reference: string;
  party: string;
  contact?: string | null;
  amount: number;
  rate?: number | null;
  status: string;
  verified: boolean;
  /** True when this transaction actually contributed PV. */
  counted: boolean;
  verification_label: string;
  verified_at?: string | null;
  verified_by?: string | null;
  recorded_at?: string | null;
  occurred_at?: string | null;
  contribution_type?: string | null;
  source?: string | null;
  ledger_group_id?: string | null;
  pv: number;
  pv_formula: string;
}

export interface ProxyPvPendingItem {
  kind: ProxyPvActivityKind;
  /** ISO date (Kampala) the pending item was last touched. */
  day: string;
  reference: string;
  label: string;
  amount: number;
  status: string;
  /** PV the item would earn once it clears its gate. */
  potential_pv: number;
  /** Plain-language reason it is not counted yet. */
  gate: string;
}

export interface ProxyPvPendingFeed {
  agent_id: string;
  period_month: string;
  generated_at: string;
  items: ProxyPvPendingItem[];
}

/**
 * Month-to-date items awaiting verification/payment — the mirror image of the
 * scored feed. Uses the same predicates as `get_proxy_agent_pv`'s data_quality
 * block so the two can never disagree.
 */
export function useProxyPvPendingFeed(agentId?: string | null, month?: string, enabled = true) {
  return useQuery({
    queryKey: ['proxy-pv-pending-feed', agentId ?? 'self', month ?? 'current'],
    enabled: enabled && agentId !== undefined,
    staleTime: 30_000,
    queryFn: async (): Promise<ProxyPvPendingFeed> => {
      const { data, error } = await supabase.rpc('get_proxy_agent_pv_pending_feed', {
        p_agent_id: agentId ?? null,
        p_month: month ?? null,
      });
      if (error) throw new Error(error.message);
      return data as unknown as ProxyPvPendingFeed;
    },
  });
}

export interface ProxyPvActivityDetail {
  agent_id: string;
  day: string;
  kind: ProxyPvActivityKind;
  generated_at: string;
  scoring: {
    commitment_pv_rate: number | null;
    percentage_rate: number | null;
    counted_items: number;
    pending_items: number;
    counted_basis: number;
    counted_pv: number;
    pending_pv: number;
    formula: string;
    gate: string;
  };
  items: ProxyPvActivityItem[];
}

/**
 * Underlying transactions, verification status and scoring inputs behind one
 * day's PV for one action type. Server-side only — the RPC mirrors
 * `proxy_pv_daily`'s predicates so the drilldown can't disagree with the score.
 */
export function useProxyPvActivityDetail(params: {
  agentId?: string | null;
  day: string | null;
  kind: ProxyPvActivityKind | null;
  enabled?: boolean;
}) {
  const { agentId, day, kind, enabled = true } = params;
  return useQuery({
    queryKey: ['proxy-pv-activity', agentId ?? 'self', day, kind],
    enabled: enabled && !!day && !!kind,
    staleTime: 30_000,
    queryFn: async (): Promise<ProxyPvActivityDetail> => {
      const { data, error } = await supabase.rpc('get_proxy_agent_pv_activity', {
        p_agent_id: agentId ?? null,
        p_day: day,
        p_kind: kind,
      });
      if (error) throw new Error(error.message);
      return data as unknown as ProxyPvActivityDetail;
    },
  });
}
