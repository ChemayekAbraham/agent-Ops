/** Reads tops_unknown_cadence_plans() and wraps the tops_set_plan_cadence() remediation action. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface UnknownCadencePlanRow {
  rent_request_id: string;
  tenant_name: string | null;
  agent_name: string | null;
  repayment_frequency: string | null;
  repayment_frequency_locked: boolean | null;
  total_repayment_ugx: number;
  created_at: string;
}

export interface UnknownCadencePlansPage {
  total_row_count: number;
  rows: UnknownCadencePlanRow[];
}

async function fetchUnknownCadencePlans(limit: number, offset: number): Promise<UnknownCadencePlansPage> {
  const { data, error } = await anyDb.rpc('tops_unknown_cadence_plans', { p_limit: limit, p_offset: offset });
  if (error) throw error;
  return data as UnknownCadencePlansPage;
}

export function useUnknownCadencePlans(limit: number, offset: number) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'unknownCadencePlans', limit, offset],
    queryFn: () => fetchUnknownCadencePlans(limit, offset),
    staleTime: 15_000,
  });
}

export function useSetPlanCadence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { rentRequestId: string; cadence: 'daily' | 'weekly'; reason: string }) => {
      const { error } = await anyDb.rpc('tops_set_plan_cadence', {
        p_rent_request_id: input.rentRequestId,
        p_cadence: input.cadence,
        p_reason: input.reason,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenantOpsWorkspace', 'unknownCadencePlans'] }),
  });
}
