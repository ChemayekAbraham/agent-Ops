import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface OpsSegment {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  filter: Record<string, unknown>;
  is_starter: boolean;
  sort_order: number;
}

export interface OpsSegmentRow {
  tenant_id: string;
  full_name: string | null;
  phone: string | null;
  city: string | null;
  trust_score: number;
  trust_tier: string | null;
  outstanding_ugx: number;
  matched_at: string | null;
}

export function useOpsSegments(scope: string = 'tenant') {
  return useQuery({
    queryKey: ['ops-segments', scope],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ops_saved_segments')
        .select('id, name, description, scope, filter, is_starter, sort_order')
        .eq('scope', scope)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return (data ?? []) as OpsSegment[];
    },
    staleTime: 5 * 60_000,
  });
}

export function useOpsSegmentRows(segmentId: string | null) {
  return useQuery({
    enabled: !!segmentId,
    queryKey: ['ops-segment-rows', segmentId],
    queryFn: async () => {
      if (!segmentId) return [];
      const { data, error } = await supabase.rpc('ops_query_tenants', {
        p_segment_id: segmentId,
        p_limit: 100,
      });
      if (error) throw error;
      return (data ?? []) as OpsSegmentRow[];
    },
    staleTime: 60_000,
  });
}
