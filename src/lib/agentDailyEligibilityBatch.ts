import { supabase } from '@/integrations/supabase/client';

/**
 * Each get_agent_daily_eligibility call stays at or under this many agents.
 * The authenticated role's statement timeout is 8s; a fleet-sized list was
 * averaging about a second and reaching 7.9s. The database computes only the
 * ids in the call, so several small calls stay inside that limit.
 */
export const AGENT_DAILY_ELIGIBILITY_BATCH = 25;

/** Distinct ids, original order, split into batches of `size` (default 25). */
export function chunkAgentIds(ids: readonly string[], size = AGENT_DAILY_ELIGIBILITY_BATCH): string[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error('agent eligibility batch size must be a positive integer');
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}

/**
 * Read daily eligibility for every id. Batches run together. If any batch
 * fails, no rows are returned: a partial list would look like "no target"
 * for the agents whose batch timed out.
 */
export async function fetchAgentDailyEligibility(agentIds: readonly string[]) {
  const chunks = chunkAgentIds(agentIds);
  if (chunks.length === 0) return { rows: [], error: null as null };
  const parts = await Promise.all(
    chunks.map((p_agent_ids) => supabase.rpc('get_agent_daily_eligibility', { p_agent_ids })),
  );
  const failed = parts.find((part) => part.error);
  if (failed?.error) return { rows: [], error: failed.error };
  return { rows: parts.flatMap((part) => part.data ?? []), error: null as null };
}
