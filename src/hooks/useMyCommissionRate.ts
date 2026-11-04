import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { AGENT_COMMISSION_RATE } from '@/lib/rentCalculations';

/**
 * The signed-in agent's real rent-collection commission rate, read from
 * `get_my_commission_rate()` — the same function the allocator pays from, so
 * what the screen promises is what the wallet receives (handover 58).
 *
 *   Agent with no parent ............ agent 8%, parent 0%
 *   Sub-agent with a verified parent  agent 6%, parent 2%
 *   Whitelisted / elite sub-agent ... agent 8%, parent 0%
 *
 * Until the RPC answers (or if it fails) this falls back to the no-parent
 * constants; `isFallback` says so, for screens that would rather wait.
 */
export interface MyCommissionRate {
  /** Share credited to the collecting agent, e.g. 0.08 or 0.06. */
  agentRate: number;
  /** Override paid to the parent agent, e.g. 0.02 or 0. */
  recruiterRate: number;
  /** agentRate + recruiterRate — 0.08 on every Rent Plan. */
  totalRate: number;
  isSubagent: boolean;
  whitelisted: boolean;
  /** Display label for the agent's own share, e.g. "8%" or "6%". */
  label: string;
}

export const FALLBACK_COMMISSION_RATE: MyCommissionRate = {
  agentRate: AGENT_COMMISSION_RATE,
  recruiterRate: 0,
  totalRate: AGENT_COMMISSION_RATE,
  isSubagent: false,
  whitelisted: false,
  label: formatRateLabel(AGENT_COMMISSION_RATE),
};

/** 0.08 → "8%", 0.065 → "6.5%". */
export function formatRateLabel(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

function toNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse the jsonb returned by get_my_commission_rate / get_agent_commission_rate. */
export function parseCommissionRate(raw: unknown): MyCommissionRate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return FALLBACK_COMMISSION_RATE;
  const r = raw as Record<string, unknown>;
  const agentRate = toNumber(r.agent_rate, FALLBACK_COMMISSION_RATE.agentRate);
  const recruiterRate = toNumber(r.recruiter_rate, 0);
  const totalRate = toNumber(r.total_rate, agentRate + recruiterRate);
  const label =
    typeof r.label === 'string' && r.label.trim() ? r.label.trim() : formatRateLabel(agentRate);
  return {
    agentRate,
    recruiterRate,
    totalRate,
    isSubagent: r.is_subagent === true,
    whitelisted: r.whitelisted === true,
    label,
  };
}

export function useMyCommissionRate() {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['my-commission-rate', user?.id],
    enabled: !!user?.id,
    // An agent's rate only changes when Agent Ops re-links or whitelists them.
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<MyCommissionRate> => {
      const { data, error } = await supabase.rpc('get_my_commission_rate');
      if (error) throw error;
      return parseCommissionRate(data);
    },
  });

  return {
    ...(query.data ?? FALLBACK_COMMISSION_RATE),
    isLoading: query.isLoading,
    isFallback: !query.data,
  };
}
