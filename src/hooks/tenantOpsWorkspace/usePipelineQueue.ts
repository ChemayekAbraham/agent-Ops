/** Reads tops_pipeline_queue(p_gap_label, p_owner_id) — every plan currently stalled in the funding pipeline, filtered server-side. Pair with tops_pipeline_queue_gap_counts() for unfiltered tab badge counts. */
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

async function fetchPipelineQueue(gapLabel: string | null, ownerId: string | null): Promise<PipelineQueueRow[]> {
  const { data, error } = await anyDb.rpc('tops_pipeline_queue', { p_gap_label: gapLabel, p_owner_id: ownerId });
  if (error) throw error;
  return (data ?? []) as PipelineQueueRow[];
}

export function usePipelineQueue(gapLabel: string | null, ownerId: string | null) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'pipelineQueue', gapLabel, ownerId],
    queryFn: () => fetchPipelineQueue(gapLabel, ownerId),
    staleTime: 30_000,
  });
}

async function fetchPipelineGapCounts(): Promise<Record<string, number>> {
  const { data, error } = await anyDb.rpc('tops_pipeline_queue_gap_counts');
  if (error) throw error;
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as { gap_label: string; cnt: number }[]) out[r.gap_label] = Number(r.cnt);
  return out;
}

export function usePipelineGapCounts() {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'pipelineGapCounts'],
    queryFn: fetchPipelineGapCounts,
    staleTime: 30_000,
  });
}
