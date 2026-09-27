/** Reads tops_collection_anomalies_list() and wraps the acknowledge/resolve mutations. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

export interface CollectionAnomaly {
  id: string;
  collection_id: string;
  rent_request_id: string | null;
  tenant_name: string | null;
  agent_name: string | null;
  collection_channel: string;
  rule_fired: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  detail: Record<string, unknown>;
  detected_at: string;
  status: 'open' | 'acknowledged' | 'resolved';
  acknowledged_by_name: string | null;
  acknowledged_at: string | null;
  acknowledged_note: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  resolved_note: string | null;
}

async function fetchCollectionAnomalies(status: string | null): Promise<CollectionAnomaly[]> {
  const { data, error } = await anyDb.rpc('tops_collection_anomalies_list', { p_status: status });
  if (error) throw error;
  return (data ?? []) as CollectionAnomaly[];
}

export function useCollectionAnomalies(status: string | null = 'open') {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'collectionAnomalies', status],
    queryFn: () => fetchCollectionAnomalies(status),
    staleTime: 30_000,
  });
}

function useInvalidateCollectionAnomalies() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['tenantOpsWorkspace', 'collectionAnomalies'] });
}

export function useAcknowledgeCollectionAnomaly() {
  const invalidate = useInvalidateCollectionAnomalies();
  return useMutation({
    mutationFn: async (input: { anomalyId: string; note: string }) => {
      const { error } = await anyDb.rpc('tops_acknowledge_collection_anomaly', {
        p_anomaly_id: input.anomalyId,
        p_note: input.note,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useResolveCollectionAnomaly() {
  const invalidate = useInvalidateCollectionAnomalies();
  return useMutation({
    mutationFn: async (input: { anomalyId: string; note: string }) => {
      const { error } = await anyDb.rpc('tops_resolve_collection_anomaly', {
        p_anomaly_id: input.anomalyId,
        p_note: input.note,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}
