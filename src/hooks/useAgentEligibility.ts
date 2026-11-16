import { useEffect, useState } from 'react';
import { fetchGateStatus } from '@/lib/agentVettingV2';
import { fetchMyEligibilityRaw } from '@/lib/agentCollectionInfo';
import { agentEligibilityFrom, type AgentEligibility } from '@/lib/agentRequestStatus';

/**
 * Whether this agent's requests at the COO can move on to the funders' board, and if
 * not, why ("below 50%", "not verified"). Reads the vetting gate and the agent's own
 * collection figure (agent_eligibility_of with their own id, E119).
 * null while loading or when nothing could be read; nothing blocks on it.
 */
export function useAgentEligibility(agentId: string | null | undefined, enabled = true): AgentEligibility {
  const [eligibility, setEligibility] = useState<AgentEligibility>(null);
  useEffect(() => {
    if (!enabled || !agentId) return;
    let cancelled = false;
    Promise.all([
      fetchGateStatus(agentId).catch(() => null),
      fetchMyEligibilityRaw(agentId),
    ]).then(([gate, raw]) => {
      if (!cancelled) setEligibility(agentEligibilityFrom(gate, raw));
    });
    return () => { cancelled = true; };
  }, [agentId, enabled]);
  return eligibility;
}
