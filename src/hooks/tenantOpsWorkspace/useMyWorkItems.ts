/**
 * Items assigned to the signed-in user, for "My work" on Today. Reads
 * tops_work_items directly (RLS already restricts this to the six tops_
 * roles; a client can only ever see their own via assigned_to = auth.uid()
 * plus role-gated visibility) and joins tenant name the same way
 * useTenantRisk does — a name lookup, not a money figure, so it is not
 * subject to the "every figure comes from a tops_ RPC" rule. value_at_risk_ugx
 * and every other number here is read as-is from the row, never recomputed.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

const anyDb = supabase as any;

export type WorkItemBucket = 'critical' | 'at_risk' | 'watch' | 'new';
export type WorkItemStatus = 'open' | 'in_progress' | 'closed';

export interface MyWorkItem {
  id: string;
  rentRequestId: string;
  tenantName: string | null;
  bucket: WorkItemBucket;
  reason: string;
  valueAtRiskUgx: number;
  status: WorkItemStatus;
  slaDueAt: string | null;
  isOverdue: boolean;
  escalatedTo: string | null;
  escalationNote: string | null;
}

async function fetchMyWorkItems(userId: string): Promise<MyWorkItem[]> {
  const { data: items, error } = await anyDb
    .from('tops_work_items')
    .select('id, rent_request_id, bucket, reason, value_at_risk_ugx, status, sla_due_at, escalated_to, escalation_note')
    .eq('assigned_to', userId)
    .neq('status', 'closed')
    .order('sla_due_at', { ascending: true, nullsFirst: false });
  if (error) throw error;

  const rows = (items ?? []) as Record<string, any>[];
  if (rows.length === 0) return [];

  const rentRequestIds = Array.from(new Set(rows.map((r) => String(r.rent_request_id))));
  const { data: rentRequests, error: rrError } = await anyDb
    .from('rent_requests')
    .select('id, tenant_id')
    .in('id', rentRequestIds);
  if (rrError) throw rrError;

  const tenantIdByRentRequest = new Map<string, string>(
    (rentRequests ?? []).map((r: any) => [String(r.id), String(r.tenant_id)]),
  );
  const tenantIds = Array.from(new Set(Array.from(tenantIdByRentRequest.values())));

  let nameByTenant = new Map<string, string>();
  if (tenantIds.length > 0) {
    const { data: profiles, error: profileError } = await anyDb
      .from('profiles')
      .select('id, full_name')
      .in('id', tenantIds);
    if (profileError) throw profileError;
    nameByTenant = new Map((profiles ?? []).map((p: any) => [String(p.id), p.full_name as string]));
  }

  const now = Date.now();
  return rows.map((r) => {
    const rentRequestId = String(r.rent_request_id);
    const tenantId = tenantIdByRentRequest.get(rentRequestId);
    return {
      id: String(r.id),
      rentRequestId,
      tenantName: (tenantId && nameByTenant.get(tenantId)) || null,
      bucket: r.bucket as WorkItemBucket,
      reason: r.reason as string,
      valueAtRiskUgx: Number(r.value_at_risk_ugx),
      status: r.status as WorkItemStatus,
      slaDueAt: (r.sla_due_at as string) ?? null,
      isOverdue: !!r.sla_due_at && new Date(r.sla_due_at).getTime() < now,
      escalatedTo: (r.escalated_to as string) ?? null,
      escalationNote: (r.escalation_note as string) ?? null,
    };
  });
}

export function useMyWorkItems() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'myWorkItems', user?.id],
    queryFn: () => fetchMyWorkItems(user!.id),
    enabled: !!user?.id,
    staleTime: 15_000,
  });
}
