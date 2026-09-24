import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Executive weekly metrics — the ONE data layer for department numbers
 * (P2 #11, handover 123). Every dashboard tile that shows a Tenant / Agent /
 * Partner / Landlord Ops weekly figure must read it from here; do not
 * recompute these numbers in a component or another RPC.
 *
 * Backed by get_{tenant,agent,partner,landlord}_ops_weekly_metrics().
 */
export type OpsDepartment = 'tenant' | 'agent' | 'partner' | 'landlord';

export interface OpsWeeklyMetric {
  metric_key: string;
  label: string;
  unit: 'count' | 'ugx';
  /** stock = point-in-time level; flow = total over the last 7 days */
  metric_kind: 'stock' | 'flow';
  current_value: number;
  /** null until a snapshot 7 days old exists (week_ago_source = 'no_snapshot_yet') */
  week_ago_value: number | null;
  net_change: number | null;
  /** percent, 1 dp; null when week-ago is null or zero */
  pct_change: number | null;
  projection_7d: number | null;
  projection_method: 'linear_wow' | 'run_rate_7d' | 'schedule_plus_past_term' | 'unavailable';
  week_ago_source: 'reconstructed' | 'prior_window' | 'snapshot' | 'no_snapshot_yet';
  week_ago_at: string | null;
  /** plain-language definition of the figure — show it in a tooltip */
  basis: string;
  as_of: string;
}

const RPC: Record<OpsDepartment, string> = {
  tenant: 'get_tenant_ops_weekly_metrics',
  agent: 'get_agent_ops_weekly_metrics',
  partner: 'get_partner_ops_weekly_metrics',
  landlord: 'get_landlord_ops_weekly_metrics',
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function useOpsWeeklyMetrics(department: OpsDepartment, enabled = true) {
  return useQuery<OpsWeeklyMetric[]>({
    queryKey: ['ops-weekly-metrics', department],
    enabled,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)(RPC[department]);
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        ...r,
        current_value: Number(r.current_value ?? 0),
        week_ago_value: num(r.week_ago_value),
        net_change: num(r.net_change),
        pct_change: num(r.pct_change),
        projection_7d: num(r.projection_7d),
      })) as OpsWeeklyMetric[];
    },
  });
}

/** Convenience: index a department's metrics by metric_key. */
export function indexOpsMetrics(rows: OpsWeeklyMetric[] | undefined): Record<string, OpsWeeklyMetric> {
  return Object.fromEntries((rows ?? []).map((r) => [r.metric_key, r]));
}
