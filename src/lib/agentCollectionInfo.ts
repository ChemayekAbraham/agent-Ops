/**
 * E100 (COO decision): agents can always post and move requests. What is left of the old
 * posting gate is information: the agent's collection against the 50% rule
 * (agent_eligibility_of, the same rule as the Agent Ops ranking board). Below 50% a
 * request still moves but waits at the COO desk and can't be funded. Nothing blocks on it.
 */
import { supabase } from '@/integrations/supabase/client';

type UntypedRpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
const rpc: UntypedRpc = (fn, args) => (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);

export const COLLECTION_RULE_PCT = 50;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The collection percentage (0–100) from the agent eligibility JSON: `pct` (a whole or
 * one-decimal percentage, as on the ranking board), else collected ÷ due. null when neither
 * is there.
 */
export function parseCollectionPct(raw: unknown): number | null {
  let r: unknown = raw;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return null; } }
  if (Array.isArray(r)) r = r[0];
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const pct = num(o.pct) ?? num(o.collection_pct) ?? num(o.pct_collected);
  if (pct !== null) return Math.round(pct * 10) / 10;
  const due = num(o.due);
  const collected = num(o.collected);
  if (due && due > 0 && collected !== null) return Math.round((collected / due) * 1000) / 10;
  return null;
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

/** "52.8" or "53": one decimal only when there is one. */
export const formatPct = (p: number): string => (Number.isInteger(p) ? String(p) : p.toFixed(1));

/** The opening line in the rent request chat. Information only. */
export function collectionInfoLine(pct: number): string {
  return `Your collection: ${formatPct(pct)}% of what is due across all your plans. Below ${COLLECTION_RULE_PCT}%, your requests still move but wait at the COO desk and can't be funded.`;
}
