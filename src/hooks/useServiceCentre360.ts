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

// ============================================================
// Service Centre receivable (money put into a centre + its charge)
// ============================================================

export type SCReceivableMode = 'markup' | 'flat';
export type SCDurationUnit = 'days' | 'months' | 'years';

export interface SCReceivable {
  id: string;
  service_centre_id: string;
  mode: SCReceivableMode;
  principal_amount: number;
  markup_percent: number | null;
  total_repayable: number;
  recoverable_amount: number;
  duration_value: number;
  duration_unit: SCDurationUnit;
  duration_days: number;
  daily_amount: number;
  start_date: string;
  end_date?: string;
  days_elapsed?: number;
  expected_to_date?: number;
  status: string;
  notes: string | null;
  created_by_name?: string | null;
  created_at: string;
}

export interface SCReceivableSplit {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_phone: string | null;
  share_percent: number;
  daily_amount: number;
  created_at: string;
}

export interface ServiceCentreReceivablePayload {
  currency: string;
  receivable: SCReceivable | null;
  splits: SCReceivableSplit[];
  history: SCReceivable[];
}

/** The active receivable plan + agent split for one centre (single request). */
export function useServiceCentreReceivable(serviceCentreId: string | null) {
  return useQuery({
    queryKey: ['service-centre-receivable', serviceCentreId],
    enabled: !!serviceCentreId,
    staleTime: 30_000,
    queryFn: async (): Promise<ServiceCentreReceivablePayload> => {
      const { data, error } = await (supabase.rpc as any)('get_service_centre_receivable', {
        p_service_centre_id: serviceCentreId,
      });
      if (error) throw error;
      return data as ServiceCentreReceivablePayload;
    },
  });
}

export interface SetSCReceivableInput {
  mode: SCReceivableMode;
  principal?: number;
  markupPercent?: number;
  flatAmount?: number | null;
  durationValue: number;
  durationUnit: SCDurationUnit;
  startDate?: string | null;
  notes?: string | null;
  splits?: { agent_id: string; share_percent: number }[] | null;
}

/** Create or re-price the centre's receivable plan (and optionally its split). */
export function useSetServiceCentreReceivable(serviceCentreId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetSCReceivableInput) => {
      const { data, error } = await (supabase.rpc as any)('service_centre_set_receivable', {
        p_service_centre_id: serviceCentreId,
        p_mode: input.mode,
        p_principal: input.principal ?? 0,
        p_markup_percent: input.markupPercent ?? 33,
        p_flat_amount: input.flatAmount ?? null,
        p_duration_value: input.durationValue,
        p_duration_unit: input.durationUnit,
        p_start_date: input.startDate ?? null,
        p_notes: input.notes ?? null,
        p_splits: input.splits ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service-centre-receivable', serviceCentreId] });
      qc.invalidateQueries({ queryKey: ['service-centre-receivables-summary'] });
    },
  });
}

/** Stop a plan: 'completed' (fully recovered) or 'cancelled' (needs a reason). */
export function useCloseServiceCentreReceivable(serviceCentreId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ receivableId, status, reason }: { receivableId: string; status: 'completed' | 'cancelled'; reason?: string }) => {
      const { data, error } = await (supabase.rpc as any)('service_centre_close_receivable', {
        p_receivable_id: receivableId,
        p_status: status,
        p_reason: reason ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service-centre-receivable', serviceCentreId] });
      qc.invalidateQueries({ queryKey: ['service-centre-receivables-summary'] });
    },
  });
}

export interface SCReceivablesSummaryRow {
  receivable_id: string;
  service_centre_id: string;
  centre_agent_name: string;
  location_name: string | null;
  mode: SCReceivableMode;
  principal_amount: number;
  markup_percent: number | null;
  total_repayable: number;
  recoverable_amount: number;
  daily_amount: number;
  duration_value: number;
  duration_unit: SCDurationUnit;
  duration_days: number;
  start_date: string;
  end_date: string;
  days_elapsed: number;
  expected_to_date: number;
  agent_count: number;
  splits: { agent_id: string; agent_name: string; share_percent: number; daily_amount: number }[];
}

export interface SCReceivablesSummary {
  currency: string;
  as_at: string;
  business_date: string;
  totals: {
    centres: number;
    principal: number;
    total_repayable: number;
    recoverable: number;
    due_daily: number;
    expected_to_date: number;
    unallocated_daily: number;
  };
  rows: SCReceivablesSummaryRow[];
}

/** Company-wide service centre receivables — one request for COO/CFO views. */
export function useServiceCentreReceivablesSummary(enabled = true) {
  return useQuery({
    queryKey: ['service-centre-receivables-summary'],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<SCReceivablesSummary> => {
      const { data, error } = await (supabase.rpc as any)('get_service_centre_receivables_summary');
      if (error) throw error;
      return data as SCReceivablesSummary;
    },
  });
}
