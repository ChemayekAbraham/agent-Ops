/** Reads tops_pipeline_queue() — every plan currently stalled in the funding pipeline (approved, clock not yet started). */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export type PipelineStageKey = 'approved' | 'funded' | 'float_allocated' | 'landlord_paid' | 'receipt_confirmed';

export interface PipelineQueueRow {
  rent_request_id: string;
  tenant_name: string | null;
  agent_name: string | null;
  current_stage_key: PipelineStageKey;
  current_stage_label: string;
  gap_label: string;
  owner_id: string | null;
  owner_name: string | null;
  stage_entered_at: string;
  age_days: number;
}

async function fetchPipelineQueue(): Promise<PipelineQueueRow[]> {
  const { data, error } = await anyDb.rpc('tops_pipeline_queue');
  if (error) throw error;
  return (data ?? []) as PipelineQueueRow[];
}

export function usePipelineQueue() {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'pipelineQueue'],
    queryFn: fetchPipelineQueue,
    staleTime: 30_000,
  });
}
