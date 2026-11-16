import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { fetchGateStatus } from '@/lib/agentVettingV2';
import { fetchMyEligibilityRaw } from '@/lib/agentCollectionInfo';
import { canViewDeskReads } from '@/lib/deskViewerRoles';
import { agentEligibilityFrom, type AgentEligibility } from '@/lib/agentRequestStatus';

/**
 * Whether this agent's requests at the COO can move on to the funders' board, and if
 * not, why ("below 50%", "not verified"). Reads the vetting gate for everyone and the
 * collection rule (agent_eligibility_of) only where the server lets this user read it.
 * null while loading or when nothing could be read; nothing blocks on it.
 */
export function useAgentEligibility(agentId: string | null | undefined, enabled = true): AgentEligibility {
  const { enabledRoles } = useAuth();
  const canReadCollection = canViewDeskReads(enabledRoles);
  const [eligibility, setEligibility] = useState<AgentEligibility>(null);
  useEffect(() => {
    if (!enabled || !agentId) return;
    let cancelled = false;
    Promise.all([
      fetchGateStatus(agentId).catch(() => null),
      canReadCollection ? fetchMyEligibilityRaw(agentId) : Promise.resolve(null),
    ]).then(([gate, raw]) => {
      if (!cancelled) setEligibility(agentEligibilityFrom(gate, raw));
    });
    return () => { cancelled = true; };
  }, [agentId, enabled, canReadCollection]);
  return eligibility;
}
