/** Reads tops_agent_float_adequacy(p_for_date) — one row per active agent (has a live plan). */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface AgentFloatAdequacy {
  agent_id: string;
  agent_name: string | null;
  float_balance_ugx: number;
  expected_obligation_ugx: number;
  adequacy_ratio: number | null;
  shortfall_ugx: number;
  tenants_at_risk: number;
}

async function fetchAgentFloatAdequacy(forDate: string): Promise<AgentFloatAdequacy[]> {
  const { data, error } = await anyDb.rpc('tops_agent_float_adequacy', { p_for_date: forDate });
  if (error) throw error;
  return ((data ?? []) as Record<string, any>[]).map((r) => ({
    agent_id: r.agent_id,
    agent_name: r.agent_name ?? null,
    float_balance_ugx: Number(r.float_balance_ugx),
    expected_obligation_ugx: Number(r.expected_obligation_ugx),
    adequacy_ratio: r.adequacy_ratio != null ? Number(r.adequacy_ratio) : null,
    shortfall_ugx: Number(r.shortfall_ugx),
    tenants_at_risk: Number(r.tenants_at_risk),
  }));
}

export function useAgentFloatAdequacy(forDate: string) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'agentFloatAdequacy', forDate],
    queryFn: () => fetchAgentFloatAdequacy(forDate),
    staleTime: 30_000,
  });
}
