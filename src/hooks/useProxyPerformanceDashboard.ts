import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Single aggregate read for /dashboard/agent/proxy.
 * The RPC is SECURITY DEFINER and self-scopes via proxy_cc_resolve_agent, so a
 * proxy agent can only ever read their own figures.
 * Brought In = note status 'activated' (the lifecycle's confirmed state).
 * Earned commission = posted wallet ledger credits; Pending = unpaid note rewards.
 */
export type ProxyRange = '7d' | '30d' | 'month';

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

export function useProxyPerformanceDashboard(userId: string | undefined, range: ProxyRange) {
  return useQuery({
    queryKey: ['proxy-performance-dashboard', userId, range],
    enabled: !!userId,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<ProxyPerformanceDashboard> => {
      const { data, error } = await supabase.rpc('get_proxy_agent_performance_dashboard' as never, {
        p_agent_id: null,
        p_range: range,
      } as never);
      if (error) throw new Error(error.message);
      return data as unknown as ProxyPerformanceDashboard;
    },
  });
}
