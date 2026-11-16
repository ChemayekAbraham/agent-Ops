import { useEffect, useState } from 'react';
import { fetchGateStatus, type GateStatus } from '@/lib/agentVettingV2';

/**
 * E111: the agent's posting gate (agent_vetting_gate_status). Agents always post; only
 * `blocked` (the switch turned back on) stops them. `notice` is a calm line to show.
 * null while loading or when it can't be read: then nothing is blocked or shown.
 */
export function useAgentGateStatus(agentId: string | null | undefined, enabled = true): GateStatus | null {
  const [gate, setGate] = useState<GateStatus | null>(null);
  useEffect(() => {
    if (!enabled || !agentId) return;
    let cancelled = false;
    fetchGateStatus(agentId)
      .then((g) => { if (!cancelled) setGate(g); })
      .catch(() => { if (!cancelled) setGate(null); });
    return () => { cancelled = true; };
  }, [agentId, enabled]);
  return gate;
}
