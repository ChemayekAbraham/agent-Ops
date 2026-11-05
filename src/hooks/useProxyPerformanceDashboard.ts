import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Single aggregate read for /dashboard/agent/proxy.
 * The RPC is SECURITY DEFINER and self-scopes via proxy_cc_resolve_agent, so a
 * proxy agent can only ever read their own figures.
 * Brought In = note status 'activated' (the lifecycle's confirmed state).
 * Earned commission = posted wallet ledger credits; Pending = unpaid note rewards.
 */
export type ProxyRange = 'today' | 'yesterday' | '7d' | '30d' | 'month';

export interface ProxyPerformanceDashboard {
  agent_id: string;
  generated_at: string;
  today: string;
  notes: {
    created: number; brought_in: number; pending: number; other: number;
    brought_in_amount: number; pending_amount: number;
    created_today: number; brought_in_today: number; brought_in_amount_today: number;
    created_this_week: number;
  };
  commission: {
    earned: number; notes: number; initial_support: number; top_ups: number; today: number;
    pending: number; pending_notes: number; note_rate: number;
    initial_support_pct: number; top_up_pct: number;
  };
  targets: { daily: number; weekly: number; week_start: string; days_remaining: number };
  series: { date: string; brought_in: number; pending: number }[];
  recent: {
    id: string; partner_name: string; amount: number; status: string;
    created_at: string; brought_in_at: string | null; house_count: number; commission: number;
  }[];
}

const CACHE_PREFIX = 'welile.proxy-dash.v1';
const cacheKey = (userId: string, range: ProxyRange) => `${CACHE_PREFIX}.${userId}.${range}`;

/** Last summary this device saw for the agent: shown instantly while the fresh one loads. */
function readCachedSummary(userId: string | undefined, range: ProxyRange): ProxyPerformanceDashboard | undefined {
  if (!userId) return undefined;
  try {
    const raw = window.localStorage.getItem(cacheKey(userId, range));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as ProxyPerformanceDashboard;
    // Today's figures from another day would be wrong, so only a same-day summary is reused.
    const kampalaToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Kampala' });
    return parsed?.agent_id === userId && parsed.today === kampalaToday ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedSummary(userId: string, range: ProxyRange, value: ProxyPerformanceDashboard) {
  try {
    window.localStorage.setItem(cacheKey(userId, range), JSON.stringify(value));
  } catch { /* storage full or blocked: the live read still works */ }
}

/** Shared by the dashboard and by the route guard, which starts this read while access is being verified. */
export function proxyPerformanceQueryOptions(userId: string | undefined, range: ProxyRange) {
  return {
    queryKey: ['proxy-performance-dashboard', userId, range] as const,
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: async (): Promise<ProxyPerformanceDashboard> => {
      const { data, error } = await supabase.rpc('get_proxy_agent_performance_dashboard' as never, {
        p_agent_id: null,
        p_range: range,
      } as never);
      if (error) throw new Error(error.message);
      const summary = data as unknown as ProxyPerformanceDashboard;
      if (userId) writeCachedSummary(userId, range, summary);
      return summary;
    },
  };
}

export function useProxyPerformanceDashboard(userId: string | undefined, range: ProxyRange) {
  return useQuery({
    ...proxyPerformanceQueryOptions(userId, range),
    placeholderData: (prev) => prev ?? readCachedSummary(userId, range),
  });
}
