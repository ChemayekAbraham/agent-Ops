/**
 * Reads tops_agent_attainment(p_from, p_to) — per-agent reading of the same
 * basis tops_collection_scoreboard uses. No incentive figure, no rank — the
 * caller must not sort this into a leaderboard; render alphabetically or by
 * shortfall context, never "top agent this week".
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface AgentAttainment {
  agent_id: string;
  agent_name: string | null;
  expected_ugx: number;
  collected_on_schedule_ugx: number;
  coverage_pct: number | null;
  attribution_caveat: string;
}

async function fetchAgentAttainment(from: string, to: string): Promise<AgentAttainment[]> {
  const { data, error } = await anyDb.rpc('tops_agent_attainment', { p_from: from, p_to: to });
  if (error) throw error;
  return ((data ?? []) as Record<string, any>[]).map((r) => ({
    agent_id: r.agent_id,
    agent_name: r.agent_name ?? null,
    expected_ugx: Number(r.expected_ugx),
    collected_on_schedule_ugx: Number(r.collected_on_schedule_ugx),
    coverage_pct: r.coverage_pct != null ? Number(r.coverage_pct) : null,
    attribution_caveat: r.attribution_caveat as string,
  }));
}

export function useAgentAttainment(from: string, to: string) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'agentAttainment', from, to],
    queryFn: () => fetchAgentAttainment(from, to),
    staleTime: 30_000,
  });
}
