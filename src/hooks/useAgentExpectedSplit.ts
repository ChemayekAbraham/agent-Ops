/**
 * Today's pinned expected, split into in-term rent and arrears.
 *
 * Since the arrears fallback was un-gated (migration 20261019104000) the daily
 * bill blends two different jobs: rent falling due inside a plan's term, and
 * plans that ran past their end date still owing. On 2026-10-19 arrears were
 * the majority of the board — UGX 10,329,756 against 7,361,429 in-term — so an
 * agent reading a single "UGX 214,130" cannot tell routine collection from a
 * tenant who has run over.
 *
 * ONE round trip for however many agents are asked about. `agent_expected_split`
 * takes an array and returns a row per id, so a fleet screen passes every agent
 * in a single call rather than firing one query per row. Always pass the whole
 * set you need; never call this hook inside a list item.
 *
 * Authorisation lives in the RPC (staff see anyone, an agent sees only
 * themselves), so there is nothing to check here.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface AgentExpectedSplit {
  agentId: string;
  /** Expected today from plans still inside their term. */
  inTermUgx: number;
  /** Expected today from plans past their end date that still owe. */
  arrearsUgx: number;
  /** inTermUgx + arrearsUgx — equals the agent's pinned bill for the day. */
  totalUgx: number;
  inTermPlans: number;
  arrearsPlans: number;
}

const num = (v: unknown) => Number(v) || 0;

/**
 * @param agentIds every agent to resolve, in one call. Pass [] to stay idle.
 * @param day      optional YYYY-MM-DD; defaults to today in Africa/Kampala.
 */
export function useAgentExpectedSplit(agentIds: string[], day?: string) {
  // Sorted + joined so re-renders with the same set reuse the cache instead of
  // refetching on a new array identity.
  const key = useMemo(() => [...agentIds].sort().join(','), [agentIds]);

  return useQuery({
    queryKey: ['agent-expected-split', key, day ?? 'today'],
    enabled: agentIds.length > 0,
    // The pin is written once at 00:05 EAT and does not move when a collection
    // is recorded, so this needs no invalidation on payment — only a periodic
    // refresh to pick up a same-day backfill.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Map<string, AgentExpectedSplit>> => {
      const { data, error } = await supabase.rpc('agent_expected_split', {
        p_agent_ids: agentIds,
        ...(day ? { p_day: day } : {}),
      });
      if (error) throw error;

      const out = new Map<string, AgentExpectedSplit>();
      (data ?? []).forEach((r) => {
        out.set(r.agent_id, {
          agentId: r.agent_id,
          inTermUgx: num(r.in_term_ugx),
          arrearsUgx: num(r.arrears_ugx),
          totalUgx: num(r.total_ugx),
          inTermPlans: num(r.in_term_plans),
          arrearsPlans: num(r.arrears_plans),
        });
      });
      return out;
    },
  });
}

/** Single-agent convenience. Still one round trip; same cache as the batch. */
export function useOwnExpectedSplit(agentId: string | null | undefined) {
  const ids = useMemo(() => (agentId ? [agentId] : []), [agentId]);
  const q = useAgentExpectedSplit(ids);
  return { ...q, data: agentId ? q.data?.get(agentId) : undefined };
}
