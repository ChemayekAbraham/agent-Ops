/**
 * Batch work-item lookup keyed by rent_request_id — enrichment only (a
 * bucket/assignment badge on rows Collections and Calling already fetched
 * and already sorted server-side). Never used to re-sort or re-page a
 * Collections list; Calling's own hook already has an established, scoped
 * exception to reorder its one already-fetched page, and may use this for
 * that.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { WorkItemBucket, WorkItemStatus } from './useMyWorkItems';

const anyDb = supabase as any;

export interface WorkItemBadge {
  bucket: WorkItemBucket;
  status: WorkItemStatus;
  assignedTo: string | null;
}

export async function fetchWorkItemsByRentRequestIds(rentRequestIds: string[]): Promise<Map<string, WorkItemBadge>> {
  if (rentRequestIds.length === 0) return new Map();
  const { data, error } = await anyDb
    .from('tops_work_items')
    .select('rent_request_id, bucket, status, assigned_to')
    .in('rent_request_id', rentRequestIds)
    .neq('status', 'closed');
  if (error) throw error;

  const map = new Map<string, WorkItemBadge>();
  for (const row of (data ?? []) as Record<string, any>[]) {
    map.set(String(row.rent_request_id), {
      bucket: row.bucket as WorkItemBucket,
      status: row.status as WorkItemStatus,
      assignedTo: (row.assigned_to as string) ?? null,
    });
  }
  return map;
}

export function useWorkItemsByRentRequestIds(rentRequestIds: string[]) {
  const ids = Array.from(new Set(rentRequestIds)).sort();
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'workItemsByRentRequest', ids],
    queryFn: () => fetchWorkItemsByRentRequestIds(ids),
    enabled: ids.length > 0,
    staleTime: 15_000,
  });
}

export const BUCKET_RANK: Record<WorkItemBucket, number> = {
  critical: 0,
  at_risk: 1,
  watch: 2,
  new: 3,
};
