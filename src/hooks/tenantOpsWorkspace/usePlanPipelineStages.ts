/** Reads the new tops_plan_pipeline_stages() RPC (existing tables only, per its own migration). */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface PlanPipelineStage {
  stage_key: 'approved' | 'funded' | 'float_allocated' | 'landlord_paid' | 'receipt_confirmed' | 'clock_started';
  stage_label: string;
  occurred_at: string | null;
  actor_id: string | null;
  actor_name: string | null;
  age_days: number | null;
}

async function fetchPlanPipelineStages(rentRequestId: string): Promise<PlanPipelineStage[]> {
  const { data, error } = await anyDb.rpc('tops_plan_pipeline_stages', { p_rent_request_id: rentRequestId });
  if (error) throw error;
  return (data ?? []) as PlanPipelineStage[];
}

export function usePlanPipelineStages(rentRequestId: string | undefined) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'planPipelineStages', rentRequestId],
    queryFn: () => fetchPlanPipelineStages(rentRequestId as string),
    enabled: !!rentRequestId,
    staleTime: 60_000,
  });
}
