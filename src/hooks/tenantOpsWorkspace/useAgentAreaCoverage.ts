/** Reads tops_agent_area_coverage(p_level) — which agents cover which area, and how many live plans each holds there. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { AreaLevel } from './useAreaBook';

const anyDb = supabase as any;

export interface AgentAreaCoverageRow {
  area_key: string | null;
  area_name: string;
  agent_id: string;
  agent_name: string | null;
  plan_count: number;
}

async function fetchAgentAreaCoverage(level: AreaLevel): Promise<AgentAreaCoverageRow[]> {
  const { data, error } = await anyDb.rpc('tops_agent_area_coverage', { p_level: level });
  if (error) throw error;
  return ((data ?? []) as Record<string, any>[]).map((r) => ({
    area_key: r.area_key ?? null,
    area_name: r.area_name,
    agent_id: r.agent_id,
    agent_name: r.agent_name ?? null,
    plan_count: Number(r.plan_count),
  }));
}

export function useAgentAreaCoverage(level: AreaLevel) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'agentAreaCoverage', level],
    queryFn: () => fetchAgentAreaCoverage(level),
    staleTime: 60_000,
  });
}
