/**
 * Agent Ops review of agent vetting: the queue, one agent's full submission,
 * and the approve/reject decision. The RPCs refuse anyone who is not Agent Ops
 * (or super_admin / cto / coo), so these hooks only fetch for signed-in users
 * and surface the server's refusal as an error.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { identityPhotoUrl } from '@/hooks/useIdentityPhotos';
import { parseVettingQueue, type VettingQueue, type VettingStatus } from '@/lib/agentVetting';

const rpc = (fn: string, args?: Record<string, unknown>) => (supabase.rpc as any)(fn, args);

export type VettingQueueFilter = {
  status?: VettingStatus | null;
  search?: string;
  inScopeOnly?: boolean;
  page?: number;
  pageSize?: number;
};

export function useAgentVettingQueue(filter: VettingQueueFilter = {}) {
  const { user } = useAuth();
  const status = filter.status === undefined ? 'submitted' : filter.status;
  const pageSize = filter.pageSize ?? 50;
  const page = filter.page ?? 0;
  return useQuery({
    queryKey: ['agent-vetting-queue', user?.id, status, filter.search ?? '', !!filter.inScopeOnly, page, pageSize],
    enabled: !!user?.id,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<VettingQueue> => {
      const { data, error } = await rpc('agent_vetting_queue', {
        p_status: status,
        p_search: filter.search?.trim() || null,
        p_in_scope_only: !!filter.inScopeOnly,
        p_limit: pageSize,
        p_offset: page * pageSize,
      });
      if (error) throw error;
      return parseVettingQueue(data);
    },
  });
}

/** One agent's submission as the server returns it (agent_vetting row plus review context). */
export type AgentVettingDetail = Record<string, any> & {
  agent_id: string;
  status: VettingStatus;
  name: string | null;
  gps_drift_m: number | null;
  events: { event: string; actor_id: string | null; detail: Record<string, unknown>; at: string }[];
};

export function useAgentVettingDetail(agentId: string | null | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['agent-vetting-detail', agentId],
    enabled: !!user?.id && !!agentId,
    staleTime: 15_000,
    queryFn: async (): Promise<AgentVettingDetail | null> => {
      const { data, error } = await rpc('agent_vetting_detail', { p_agent_id: agentId });
      if (error) throw error;
      return (data ?? null) as AgentVettingDetail | null;
    },
  });
}

/**
 * Short-lived links for the submitted photos (identity-verification bucket).
 * Agent Ops can read an agent's folder once the agent has submitted.
 */
export function useAgentVettingPhotos(detail: AgentVettingDetail | null | undefined) {
  const paths = {
    id_front: detail?.id_front_path as string | null | undefined,
    id_back: detail?.id_back_path as string | null | undefined,
    passport: detail?.passport_photo_path as string | null | undefined,
    // The ID Agent Ops last decided on, when the agent has since replaced it (see idComparison).
    prev_id_front: detail?.prev_id_front_path as string | null | undefined,
    prev_id_back: detail?.prev_id_back_path as string | null | undefined,
  };
  return useQuery({
    queryKey: ['agent-vetting-photos', detail?.agent_id, paths.id_front, paths.id_back, paths.passport, paths.prev_id_front, paths.prev_id_back],
    enabled: !!detail,
    staleTime: 4 * 60_000, // links last 5 minutes
    queryFn: async () => {
      const [id_front, id_back, passport, prev_id_front, prev_id_back] = await Promise.all([
        identityPhotoUrl(paths.id_front),
        identityPhotoUrl(paths.id_back),
        identityPhotoUrl(paths.passport),
        identityPhotoUrl(paths.prev_id_front),
        identityPhotoUrl(paths.prev_id_back),
      ]);
      return { id_front, id_back, passport, prev_id_front, prev_id_back };
    },
  });
}

export function useDecideAgentVetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { agentId: string; approve: boolean; note?: string }) => {
      const { data, error } = await rpc('decide_agent_vetting', {
        p_agent_id: args.agentId,
        p_approve: args.approve,
        p_note: args.note?.trim() || null,
      });
      if (error) throw new Error(error.message);
      const r = (data ?? {}) as { success?: boolean; message?: string; status?: VettingStatus };
      if (!r.success) throw new Error(r.message ?? 'Could not save the decision.');
      return r;
    },
    onSuccess: (_r, args) => {
      qc.invalidateQueries({ queryKey: ['agent-vetting-queue'] });
      qc.invalidateQueries({ queryKey: ['agent-vetting-detail', args.agentId] });
    },
  });
}
