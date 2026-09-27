/** The current (open/in_progress) work item for one plan, if any — powers the work-item actions on Tenant 360's ActionsRow. */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { WorkItemBucket, WorkItemStatus } from './useMyWorkItems';

const anyDb = supabase as any;

export interface WorkItemSummary {
  id: string;
  bucket: WorkItemBucket;
  reason: string;
  valueAtRiskUgx: number;
  status: WorkItemStatus;
  assignedTo: string | null;
  slaDueAt: string | null;
  escalatedTo: string | null;
}

async function fetchWorkItemForRentRequest(rentRequestId: string): Promise<WorkItemSummary | null> {
  const { data, error } = await anyDb
    .from('tops_work_items')
    .select('id, bucket, reason, value_at_risk_ugx, status, assigned_to, sla_due_at, escalated_to')
    .eq('rent_request_id', rentRequestId)
    .neq('status', 'closed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  return {
    id: String(data.id),
    bucket: data.bucket as WorkItemBucket,
    reason: data.reason as string,
    valueAtRiskUgx: Number(data.value_at_risk_ugx),
    status: data.status as WorkItemStatus,
    assignedTo: (data.assigned_to as string) ?? null,
    slaDueAt: (data.sla_due_at as string) ?? null,
    escalatedTo: (data.escalated_to as string) ?? null,
  };
}

export function useWorkItemForRentRequest(rentRequestId: string | undefined) {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'workItemForRentRequest', rentRequestId],
    queryFn: () => fetchWorkItemForRentRequest(rentRequestId as string),
    enabled: !!rentRequestId,
    staleTime: 15_000,
  });
}
