/** Reads tops_agent_integrity_signals(p_from, p_to) — reversed collections, balance-correction frequency, transfer churn. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface AgentIntegritySignals {
  agent_id: string;
  agent_name: string | null;
  reversed_collections_count: number;
  reversed_collections_ugx: number;
  balance_correction_count: number;
  transfer_churn_count: number;
}

async function fetchAgentIntegritySignals(from: string, to: string): Promise<AgentIntegritySignals[]> {
  const { data, error } = await anyDb.rpc('tops_agent_integrity_signals', { p_from: from, p_to: to });
  if (error) throw error;
  return ((data ?? []) as Record<string, any>[]).map((r) => ({
    agent_id: r.agent_id,
    agent_name: r.agent_name ?? null,
    reversed_collections_count: Number(r.reversed_collections_count),
    reversed_collections_ugx: Number(r.reversed_collections_ugx),
    balance_correction_count: Number(r.balance_correction_count),
    transfer_churn_count: Number(r.transfer_churn_count),
  }));
}

export function useAgentIntegritySignals(from: string, to: string) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'agentIntegritySignals', from, to],
    queryFn: () => fetchAgentIntegritySignals(from, to),
    staleTime: 30_000,
  });
}
