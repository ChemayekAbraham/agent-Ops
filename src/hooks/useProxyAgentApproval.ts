import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type ProxyApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'suspended';

export interface MyProxyStatus {
  status: ProxyApprovalStatus;
  full_name: string | null;
  phone: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
}

/** Database-level proxy-agent access identifier for the signed-in user. */
export function useMyProxyAgentStatus(userId?: string | null) {
  return useQuery({
    queryKey: ['my-proxy-agent-status', userId ?? 'anon'],
    enabled: !!userId,
    staleTime: 30_000,
    // Access gate: always re-verify against the server on mount so revoked or
    // suspended proxy agents cannot ride a cached "approved" verdict.
    refetchOnMount: 'always',
    retry: false,

    queryFn: async (): Promise<MyProxyStatus> => {
      const { data, error } = await supabase.rpc('my_proxy_agent_status');
      if (error) throw new Error(error.message);
      const row = (data ?? {}) as Partial<MyProxyStatus>;
      return {
        status: (row.status as ProxyApprovalStatus) ?? 'none',
        full_name: row.full_name ?? null,
        phone: row.phone ?? null,
        submitted_at: row.submitted_at ?? null,
        reviewed_at: row.reviewed_at ?? null,
        review_notes: row.review_notes ?? null,
      };
    },
  });
}

export interface ProxyApplicationRow {
  agent_user_id: string;
  full_name: string | null;
  phone: string | null;
  nin: string | null;
  invite_code: string | null;
  status: ProxyApprovalStatus;
  submitted_at: string;
  reviewed_at: string | null;
  review_notes: string | null;
  reviewer_name: string | null;
  lead_name: string | null;
  profile_name: string | null;
  profile_phone: string | null;
}

export function useProxyAgentApplications(status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending') {
  return useQuery({
    queryKey: ['proxy-agent-applications', status],
    queryFn: async (): Promise<ProxyApplicationRow[]> => {
      const { data, error } = await supabase.rpc('partner_ops_list_proxy_agent_applications', {
        p_status: status,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as ProxyApplicationRow[];
    },
  });
}

export function useDecideProxyAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { agentUserId: string; decision: 'approved' | 'rejected'; notes?: string }) => {
      const { data, error } = await supabase.rpc('partner_ops_decide_proxy_agent', {
        p_agent_user_id: vars.agentUserId,
        p_decision: vars.decision,
        p_notes: vars.notes ?? null,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['proxy-agent-applications'] });
      void qc.invalidateQueries({ queryKey: ['my-proxy-agent-status'] });
    },
  });
}
