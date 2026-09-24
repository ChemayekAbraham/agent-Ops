/**
 * Agent self-track for overdue field-chase touches (EAT calendar day).
 *
 * DONE = tapped_at AND called_at on the same touch_day.
 * Does NOT use tenant_call_reports / crm_call_sessions (ops RLS).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface AgentOverdueTouch {
  rent_request_id: string;
  tenant_id: string | null;
  touch_day: string;
  tapped_at: string | null;
  called_at: string | null;
  done: boolean;
}

export interface AgentOverdueTouchesToday {
  agent_id: string;
  touch_day: string;
  touches: AgentOverdueTouch[];
}

type LooseRpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as LooseRpc;

export const agentOverdueTouchesKey = (agentId: string | null | undefined) =>
  ['agent-overdue-touches-today', agentId] as const;

export function useAgentOverdueTouches(
  agentId: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: agentOverdueTouchesKey(agentId),
    enabled: Boolean(agentId) && enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<AgentOverdueTouchesToday> => {
      const { data, error } = await rpc('agent_overdue_touches_today', {
        p_agent_id: agentId,
      });
      if (error) throw error;
      const payload = (data ?? {}) as Partial<AgentOverdueTouchesToday>;
      return {
        agent_id: String(payload.agent_id ?? agentId),
        touch_day: String(payload.touch_day ?? ''),
        touches: Array.isArray(payload.touches)
          ? (payload.touches as AgentOverdueTouch[])
          : [],
      };
    },
  });
}

export function useMarkAgentOverdueTouch(agentId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      rentRequestId: string;
      event: 'tapped' | 'called';
      tenantId?: string | null;
    }) => {
      const { data, error } = await rpc('agent_overdue_touch_mark', {
        p_rent_request_id: args.rentRequestId,
        p_event: args.event,
        p_tenant_id: args.tenantId ?? null,
      });
      if (error) throw error;
      return data as AgentOverdueTouch & { id?: string };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentOverdueTouchesKey(agentId) });
    },
  });
}

/** Map rent_request_id → touch for O(1) row badges. */
export function touchMapFrom(
  touches: AgentOverdueTouch[] | undefined,
): Record<string, AgentOverdueTouch> {
  const map: Record<string, AgentOverdueTouch> = {};
  for (const t of touches ?? []) {
    if (t?.rent_request_id) map[t.rent_request_id] = t;
  }
  return map;
}
