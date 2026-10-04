import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface AgentAdvanceActivity {
  subagents: number;
  rent_requests: number;
  collections: number;
  collected_amount: number;
  promissory_notes: number;
  verified_houses: number;
  signals: number;
  eligible: boolean;
}

const EMPTY: AgentAdvanceActivity = {
  subagents: 0,
  rent_requests: 0,
  collections: 0,
  collected_amount: 0,
  promissory_notes: 0,
  verified_houses: 0,
  signals: 0,
  eligible: false,
};

/**
 * Activity gate for agent advances. An agent must have done at least ONE piece
 * of real field work before they may request an advance:
 * recruited a sub-agent, raised a rent request, collected rent, activated a
 * promissory note, or had a house they listed verified.
 *
 * Mirrors the DB function `agent_advance_activity` which is also enforced by
 * the BEFORE INSERT trigger on `agent_advance_requests`, so the UI and the
 * database never disagree.
 */
export function useAgentAdvanceActivity(userId?: string | null) {
  const query = useQuery({
    queryKey: ['agent-advance-activity', userId],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<AgentAdvanceActivity> => {
      const { data, error } = await (supabase.rpc as any)('agent_advance_activity', {
        p_user_id: userId,
      });
      if (error) throw error;
      const row = (data ?? {}) as Record<string, unknown>;
      return {
        subagents: Number(row.subagents ?? 0),
        rent_requests: Number(row.rent_requests ?? 0),
        collections: Number(row.collections ?? 0),
        collected_amount: Number(row.collected_amount ?? 0),
        promissory_notes: Number(row.promissory_notes ?? 0),
        verified_houses: Number(row.verified_houses ?? 0),
        signals: Number(row.signals ?? 0),
        eligible: Boolean(row.eligible),
      };
    },
  });

  return {
    activity: query.data ?? EMPTY,
    loading: query.isLoading,
    // Never block on a failed/loading fetch in a misleading way: the DB trigger
    // is the hard gate, the UI only pre-warns once we actually know.
    blocked: !!query.data && !query.data.eligible,
    refetch: query.refetch,
  };
}
