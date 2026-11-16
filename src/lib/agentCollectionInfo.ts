/**
 * E100 (COO decision): agents can always post and move requests. What is left of the old
 * posting gate is information: the agent's collection against the 50% rule
 * (agent_eligibility_of, the same rule as the Agent Ops ranking board). Below 50% a
 * request still moves but waits at the COO desk and can't be funded. Nothing blocks on it.
 */
import { supabase } from '@/integrations/supabase/client';

type UntypedRpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
const rpc: UntypedRpc = (fn, args) => (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);

export { COLLECTION_RULE_PCT, parseCollectionPct } from '@/lib/collectionPct';
import { COLLECTION_RULE_PCT, formatPct, parseCollectionPct } from '@/lib/collectionPct';

/** The raw agent_eligibility_of JSON ({ eligible, pct, reason, … }), or null when it can't be read. Never throws. */
export async function fetchMyEligibilityRaw(agentId: string): Promise<unknown> {
  try {
    const { data, error } = await rpc('agent_eligibility_of', { p_agent: agentId });
    return error ? null : data ?? null;
  } catch {
    return null;
  }
}

export type MyCollectionInfo = { pct: number | null; reason: string | null };

/**
 * The percentage and the server's reason text from the agent_eligibility_of JSON. The reason
 * also says when the agent is not yet verified (E119). null when there is neither.
 */
export function parseCollectionInfo(raw: unknown): MyCollectionInfo | null {
  let r: unknown = raw;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return null; } }
  if (Array.isArray(r)) r = r[0];
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const pct = parseCollectionPct(o);
  const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim() : null;
  return pct === null && reason === null ? null : { pct, reason };
}

/**
 * E119: agent_eligibility_of lets an agent read their own figure (p_agent = auth.uid());
 * anyone else's still needs a desk role. Pass the signed-in agent's own id. null when the
 * server refuses or there is nothing to show. Never throws.
 */
export async function fetchMyCollectionInfo(agentId: string): Promise<MyCollectionInfo | null> {
  return parseCollectionInfo(await fetchMyEligibilityRaw(agentId));
}

/** The agent's own collection percentage, or null when it can't be read. Never throws. */
export async function fetchMyCollectionPct(agentId: string): Promise<number | null> {
  try {
    const { data, error } = await rpc('agent_eligibility_of', { p_agent: agentId });
    if (error) return null;
    return parseCollectionPct(data);
  } catch {
    return null;
  }
}

export { formatPct } from '@/lib/collectionPct';

/** The opening line in the rent request chat. Information only. */
export function collectionInfoLine(pct: number): string {
  return `Your collection: ${formatPct(pct)}% of what is due across all your plans. Below ${COLLECTION_RULE_PCT}%, your requests still move but wait at the COO desk and can't be funded.`;
}
