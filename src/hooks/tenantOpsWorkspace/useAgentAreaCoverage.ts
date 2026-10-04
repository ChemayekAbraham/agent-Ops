/** Reads tops_agent_area_coverage(p_level, p_limit, p_offset) — which agents cover which area, and how many live plans each holds there. Server-paginated. */
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

export interface AgentAreaCoveragePage {
  total_row_count: number;
  rows: AgentAreaCoverageRow[];
}

async function fetchAgentAreaCoverage(level: AreaLevel, limit: number, offset: number): Promise<AgentAreaCoveragePage> {
  const { data, error } = await anyDb.rpc('tops_agent_area_coverage', { p_level: level, p_limit: limit, p_offset: offset });
  if (error) throw error;
  return data as AgentAreaCoveragePage;
}

export function useAgentAreaCoverage(level: AreaLevel, limit: number, offset: number) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'agentAreaCoverage', level, limit, offset],
    queryFn: () => fetchAgentAreaCoverage(level, limit, offset),
    staleTime: 60_000,
  });
}
