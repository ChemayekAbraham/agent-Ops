import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type ServiceCenterRequestStatus =
  | 'not_qualified'
  | 'qualified'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'cancelled';

export interface ServiceCenterQualification {
  agent_id: string;
  rule_version: string;
  qualifying_sub_agents: number;
  required_sub_agents: number;
  main_agent_active_tenants: number;
  required_main_agent_tenants: number;
  network_active_tenants: number;
  sub_agent_requirement_met: boolean;
  personal_tenant_requirement_met: boolean;
  is_qualified: boolean;
  qualification_progress: number;
  remaining_sub_agents: number;
  remaining_personal_tenants: number;
  qualified_at: string | null;
  request_status: ServiceCenterRequestStatus;
  request_id: string | null;
  raw_request_status: string | null;
  decision_reason: string | null;
  activity_window_days: number;
}

/**
 * Server-authoritative Free Service Center qualification summary.
 * Every threshold, count and eligibility flag comes from the database RPC —
 * the client never derives eligibility on its own.
 */
export function useServiceCenterQualification(agentId?: string) {
  return useQuery({
    queryKey: ['service-center-qualification', agentId],
    enabled: !!agentId,
    staleTime: 60_000,
    queryFn: async (): Promise<ServiceCenterQualification> => {
      const { data, error } = await (supabase.rpc as any)('get_service_center_qualification', {
        p_agent_id: agentId,
      });
      if (error) throw error;
      return data as ServiceCenterQualification;
    },
  });
}