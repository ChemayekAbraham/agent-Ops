import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';

/**
 * The agent's total exposure and headroom, as the database works them out
 * (get_agent_rent_request_capacity: agent_exposure, agent_cap, agent_headroom, blocked).
 *
 * E134 (COO 17 Nov): there is no rent ceiling per tenant. What is still true is the agent's
 * total: the outstanding balances of their tenants' Rent Plans against the UGX 100,000,000
 * exposure limit. `blocked` is true only when that limit is reached; the screens say so only
 * then. Called without a tenant (p_tenant_id null): only the agent's own figures are read.
 */
export interface AgentExposure {
  exposure: number;
  cap: number;
  headroom: number;
  blocked: boolean;
  /** The server's own words when blocked. */
  reason: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** The RPC's reply, or null when it is not the shape we know. */
export function parseAgentExposure(raw: unknown): AgentExposure | null {
  const o = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== 'object') return null;
  const exposure = num(o.agent_exposure);
  const cap = num(o.agent_cap);
  if (exposure === null || cap === null) return null;
  const headroom = num(o.agent_headroom) ?? Math.max(cap - exposure, 0);
  const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim() : null;
  return { exposure, cap, headroom, blocked: o.blocked === true, reason };
}

export async function fetchAgentExposure(agentId: string): Promise<AgentExposure | null> {
  const { data, error } = await supabase.rpc('get_agent_rent_request_capacity', {
    p_agent_id: agentId,
    p_tenant_id: null,
  } as unknown as { p_agent_id: string; p_tenant_id: string });
  if (error) throw error;
  return parseAgentExposure(data);
}

/** The signed-in agent's exposure. Read-only. */
export function useAgentExposure(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ['agent-exposure', agentId],
    queryFn: () => fetchAgentExposure(agentId as string),
    enabled: !!agentId,
    staleTime: 60_000,
  });
}

/** Share of the exposure limit in use, 0–100. */
export const exposurePct = (e: AgentExposure): number =>
  e.cap > 0 ? Math.min(100, Math.round((e.exposure / e.cap) * 100)) : 0;

/** What the agent reads when (and only when) the exposure limit is reached. */
export function exposureBlockedLine(e: AgentExposure): string {
  return e.reason
    ?? `You can't post new Rent Plans right now: your tenants' outstanding balances (${formatUGX(e.exposure)}) have reached the ${formatUGX(e.cap)} limit.`;
}
