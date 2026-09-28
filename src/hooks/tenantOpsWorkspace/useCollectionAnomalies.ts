/** Reads tops_collection_anomalies_list(p_status, p_limit, p_offset), server-paginated, and wraps the acknowledge/resolve mutations. */
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

async function fetchCollectionAnomalies(
  status: string | null,
  limit: number,
  offset: number,
): Promise<{ rows: CollectionAnomaly[]; totalRowCount: number }> {
  const [{ data, error }, { data: count, error: countError }] = await Promise.all([
    anyDb.rpc('tops_collection_anomalies_list', { p_status: status, p_limit: limit, p_offset: offset }),
    anyDb.rpc('tops_collection_anomalies_count', { p_status: status }),
  ]);
  if (error) throw error;
  if (countError) throw countError;
  return { rows: (data ?? []) as CollectionAnomaly[], totalRowCount: Number(count ?? 0) };
}

export function useCollectionAnomalies(status: string | null, limit: number, offset: number) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'collectionAnomalies', status, limit, offset],
    queryFn: () => fetchCollectionAnomalies(status, limit, offset),
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
