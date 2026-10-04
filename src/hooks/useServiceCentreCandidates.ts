import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface ServiceCentreCandidate {
  agent_id: string;
  agent_name: string;
  agent_phone: string | null;
  avatar_url: string | null;
  district: string | null;
  region: string | null;
  qualifying_sub_agents: number;
  main_agent_active_tenants: number;
  network_active_tenants: number;
  qualification_progress: number;
  is_qualified: boolean;
  existing_service_centres: number;
  request_status: string | null;
}

export interface ServiceCentreCandidateReport {
  rule_version: string;
  required_sub_agents: number;
  required_main_agent_tenants: number;
  min_progress: number;
  total: number;
  rows: ServiceCentreCandidate[];
}

/**
 * Agents at or above a progress threshold toward earning a Service Centre.
 * One server-side pass for every agent — never a per-agent round trip.
 */
export function useServiceCentreCandidates(minProgress = 50, limit = 15, offset = 0) {
  return useQuery({
    queryKey: ['sc-qualification-candidates', minProgress, limit, offset],
    queryFn: async (): Promise<ServiceCentreCandidateReport> => {
      const { data, error } = await (supabase.rpc as any)('get_service_center_qualification_candidates', {
        p_min_progress: minProgress,
        p_limit: limit,
        p_offset: offset,
      });
      if (error) throw error;
      return data as ServiceCentreCandidateReport;
    },
    staleTime: 60_000,
  });
}
