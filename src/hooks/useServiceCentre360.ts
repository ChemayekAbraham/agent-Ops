import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface SC360Agent {
  assignment_id: string;
  agent_id: string;
  agent_name: string;
  agent_phone: string | null;
  role_note: string | null;
  assigned_at: string;
  assigned_by_name: string | null;
  collected_30d: number;
  collections_30d: number;
}

export interface SC360RemovedAgent {
  assignment_id: string;
  agent_name: string;
  unassigned_at: string | null;
  unassign_reason: string | null;
}

export interface SC360Repayment {
  id: string;
  created_at: string;
  amount: number;
  expected_amount: number | null;
  shortfall_amount: number | null;
  is_partial: boolean;
  payment_method: string | null;
  agent_id: string;
  agent_name: string;
  tenant_name: string;
}

export interface SC360Advance {
  id: string;
  agent_name: string;
  principal_amount: number;
  amount_recovered: number;
  daily_deduction: number;
  duration_days: number;
  status: string;
  attached_at: string;
}

export interface ServiceCentre360 {
  currency: string;
  centre: {
    id: string;
    agent_id: string;
    agent_name: string;
    agent_phone: string | null;
    location_name: string | null;
    latitude: number;
    longitude: number;
    status: string;
    created_at: string;
    verified_at: string | null;
    approved_at: string | null;
    rejection_reason: string | null;
    verified_amount: number | null;
    cfo_approved_amount: number | null;
    cfo_decision: string | null;
    payee_name: string | null;
  };
  assigned_agents: SC360Agent[];
  removed_agents: SC360RemovedAgent[];
  repayment_totals: {
    collected_today: number;
    collected_7d: number;
    collected_30d: number;
    collected_all: number;
    payments: number;
    partial_payments: number;
  };
  repayment_history: SC360Repayment[];
  advances: SC360Advance[];
}

/** Everything about one Service Centre in a single request (no N+1). */
export function useServiceCentre360(serviceCentreId: string | null) {
  return useQuery({
    queryKey: ['service-centre-360', serviceCentreId],
    enabled: !!serviceCentreId,
    staleTime: 30_000,
    queryFn: async (): Promise<ServiceCentre360> => {
      const { data, error } = await (supabase.rpc as any)('get_service_centre_360', {
        p_service_centre_id: serviceCentreId,
      });
      if (error) throw error;
      return data as ServiceCentre360;
    },
  });
}

/** Agents eligible to be attached to a service centre — one cached request. */
export function useAssignableAgents(enabled: boolean) {
  return useQuery({
    queryKey: ['assignable-agents'],
    enabled,
    staleTime: 300_000,
    queryFn: async (): Promise<{ id: string; full_name: string | null; phone: string | null }[]> => {
      const { data, error } = await (supabase.rpc as any)('list_assignable_agents');
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

export function useAssignServiceCentreAgents(serviceCentreId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ agentIds, note }: { agentIds: string[]; note?: string }) => {
      const { data, error } = await (supabase.rpc as any)('service_centre_assign_agents', {
        p_service_centre_id: serviceCentreId,
        p_agent_ids: agentIds,
        p_note: note || null,
      });
      if (error) throw error;
      return data as { assigned: number; skipped: number };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service-centre-360', serviceCentreId] });
    },
  });
}

export function useUnassignServiceCentreAgent(serviceCentreId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ assignmentId, reason }: { assignmentId: string; reason?: string }) => {
      const { data, error } = await (supabase.rpc as any)('service_centre_unassign_agent', {
        p_assignment_id: assignmentId,
        p_reason: reason || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service-centre-360', serviceCentreId] });
    },
  });
}
