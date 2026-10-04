import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface ReliabilityRow {
  rent_request_id: string;
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  daily: number;
  rent_amount: number;
  repaid: number;
  total: number;
  outstanding: number;
  status: string | null;
  start_at: string | null;
  expected_days: number;
  paid_days: number;
  missed_days: number;
  pay_days: number;
  longest_gap: number;
  days_since_last_pay: number | null;
  last_pay_date: string | null;
  coverage_pct: number;
  progress_pct: number;
  score: number;
  band: 'excellent' | 'good' | 'watch' | 'risk';
  reliable: boolean;
}

export interface ReliabilitySummary {
  tenants: number;
  reliable: number;
  watch: number;
  risk: number;
  outstanding_total: number;
  generated_at: string;
}

/**
 * Server-computed tenant repayment reliability score.
 *
 * Everything is derived in one security-definer RPC from the authoritative
 * daily-eligibility view + `agent_collections`, so the numbers here always match
 * the Missed Days / Daily Collection tools instead of being re-derived client side.
 */
export function useTenantRepaymentReliability(limit = 800) {
  return useQuery({
    queryKey: ['tenant-repayment-reliability', limit],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_tenant_repayment_reliability' as any, {
        p_limit: limit,
        p_offset: 0,
        p_band: null,
      });
      if (error) throw error;
      const payload = (data ?? {}) as { summary?: ReliabilitySummary; rows?: ReliabilityRow[] };
      return {
        summary: payload.summary ?? { tenants: 0, reliable: 0, watch: 0, risk: 0, outstanding_total: 0, generated_at: new Date().toISOString() },
        rows: (payload.rows ?? []).map(r => ({
          ...r,
          daily: Number(r.daily || 0),
          rent_amount: Number(r.rent_amount || 0),
          repaid: Number(r.repaid || 0),
          total: Number(r.total || 0),
          outstanding: Number(r.outstanding || 0),
        })),
      };
    },
    staleTime: 120_000,
  });
}
