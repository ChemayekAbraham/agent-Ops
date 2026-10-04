/**
 * Agent block: current agent from rent_requests' own columns (assigned_agent_id
 * takes precedence over agent_id, matching the reassignment-attribution
 * convention used elsewhere in this codebase), plus proxy_agent_id where set.
 * History/transfers/replacements come from the existing
 * get_tenant_transfer_history() RPC — already used by TenantDetailPanel.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface AgentTransferEvent {
  id: string;
  occurred_at: string;
  source: string;
  from_agent_id: string | null;
  from_agent_name: string | null;
  to_agent_id: string | null;
  to_agent_name: string | null;
  actor_id: string | null;
  actor_name: string | null;
  reason: string | null;
}

export interface AgentInfo {
  currentAgentId: string | null;
  currentAgentName: string | null;
  proxyAgentId: string | null;
  proxyAgentName: string | null;
  history: AgentTransferEvent[];
}

async function fetchAgentInfo(rentRequestId: string): Promise<AgentInfo> {
  const { data: rr, error: rrError } = await supabase
    .from('rent_requests')
    .select('tenant_id, agent_id, assigned_agent_id, proxy_agent_id')
    .eq('id', rentRequestId)
    .maybeSingle();
  if (rrError) throw rrError;

  const currentAgentId: string | null = rr?.assigned_agent_id ?? rr?.agent_id ?? null;
  const proxyAgentId: string | null = rr?.proxy_agent_id ?? null;
  const idsToName = [currentAgentId, proxyAgentId].filter(Boolean) as string[];

  const [namesRes, historyRes] = await Promise.all([
    idsToName.length > 0
      ? supabase.from('profiles').select('id, full_name').in('id', idsToName)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
    rr?.tenant_id
      ? anyDb.rpc('get_tenant_transfer_history', { p_tenant_id: rr.tenant_id })
      : Promise.resolve({ data: [] }),
  ]);

  const nameById = new Map((namesRes.data ?? []).map((p) => [p.id, p.full_name]));

  return {
    currentAgentId,
    currentAgentName: currentAgentId ? nameById.get(currentAgentId) ?? null : null,
    proxyAgentId,
    proxyAgentName: proxyAgentId ? nameById.get(proxyAgentId) ?? null : null,
    history: (historyRes.data ?? []) as AgentTransferEvent[],
  };
}

export function useAgentInfo(rentRequestId: string | undefined) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'agentInfo', rentRequestId],
    queryFn: () => fetchAgentInfo(rentRequestId as string),
    enabled: !!rentRequestId,
    staleTime: 60_000,
  });
}
