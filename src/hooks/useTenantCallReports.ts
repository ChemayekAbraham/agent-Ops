import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

/**
 * Tenant Ops call tracking (append-only).
 *
 * `tenant_call_reports` rows are never updated or deleted — each call attempt is
 * a new row. `v_tenant_call_summary` gives the per-tenant rollup used by the
 * Missed Days / Calls Made lists, the Calling Hub and the tenant reports.
 *
 * `outcome` (picked_up | missed) is kept for backward compatibility with the
 * older Missed Days tool; `status` (pending | closed | missed) is the workflow
 * state the Calling Hub works with.
 */

export type TenantCallOutcome = 'picked_up' | 'missed';
export type TenantCallStatus = 'pending' | 'closed' | 'missed';

export const TENANT_CALL_STATUS_LABEL: Record<TenantCallStatus, string> = {
  pending: 'Pending',
  closed: 'Closed',
  missed: 'Missed',
};

/** A status maps onto the legacy outcome so old tools keep working. */
export const outcomeForStatus = (status: TenantCallStatus): TenantCallOutcome =>
  status === 'missed' ? 'missed' : 'picked_up';

export interface TenantCallSummary {
  tenant_id: string;
  call_count: number;
  picked_up_count: number;
  missed_count: number;
  last_call_at: string | null;
  last_picked_up_at: string | null;
  last_outcome: TenantCallOutcome | null;
  latest_comment: string | null;
  latest_comment_at: string | null;
  last_status: TenantCallStatus | null;
  pending_count: number;
  closed_count: number;
  last_follow_up_at: string | null;
}

export interface TenantCallRecord {
  id: string;
  tenant_id: string;
  rent_request_id: string | null;
  outcome: TenantCallOutcome;
  status: TenantCallStatus | null;
  follow_up_at: string | null;
  comment: string | null;
  called_by: string;
  called_at: string;
}

/** All-time call rollup for every tenant that has ever been called. */
export function useTenantCallSummaries() {
  return useQuery({
    queryKey: ['tenant-call-summaries'],
    queryFn: async () => {
      const all: TenantCallSummary[] = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        const { data, error } = await (supabase as any)
          .from('v_tenant_call_summary')
          .select('*')
          .range(from, from + page - 1);
        if (error) throw error;
        all.push(...((data || []) as TenantCallSummary[]));
        if (!data || data.length < page) break;
      }
      const map = new Map<string, TenantCallSummary>();
      all.forEach(r => map.set(r.tenant_id, r));
      return map;
    },
    staleTime: 60000,
  });
}

/** Full, untruncated call history for one tenant (newest first). */
export function useTenantCallHistory(tenantId?: string | null) {
  return useQuery({
    queryKey: ['tenant-call-history', tenantId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('tenant_call_reports')
        .select('id, tenant_id, rent_request_id, outcome, status, follow_up_at, comment, called_by, called_at')
        .eq('tenant_id', tenantId)
        .order('called_at', { ascending: false });
      if (error) throw error;
      return (data || []) as TenantCallRecord[];
    },
    enabled: !!tenantId,
    staleTime: 30000,
  });
}

/**
 * Every call record inside a date window — the source for the Calling Hub
 * reports and exports. Paged so nothing is silently truncated.
 */
export function useTenantCallRecords(fromISO?: string | null, toISO?: string | null) {
  return useQuery({
    queryKey: ['tenant-call-records', fromISO, toISO],
    queryFn: async () => {
      const all: TenantCallRecord[] = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        let q = (supabase as any)
          .from('tenant_call_reports')
          .select('id, tenant_id, rent_request_id, outcome, status, follow_up_at, comment, called_by, called_at')
          .order('called_at', { ascending: false })
          .range(from, from + page - 1);
        if (fromISO) q = q.gte('called_at', fromISO);
        if (toISO) q = q.lte('called_at', toISO);
        const { data, error } = await q;
        if (error) throw error;
        all.push(...((data || []) as TenantCallRecord[]));
        if (!data || data.length < page) break;
      }
      return all;
    },
    staleTime: 30000,
  });
}

export function useLogTenantCall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      tenantId: string;
      status?: TenantCallStatus;
      outcome?: TenantCallOutcome;
      comment?: string | null;
      rentRequestId?: string | null;
      followUpAt?: string | null;
    }) => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error('You must be signed in to log a call.');
      const status: TenantCallStatus =
        input.status ?? (input.outcome === 'missed' ? 'missed' : 'pending');
      const { error } = await (supabase as any).from('tenant_call_reports').insert({
        tenant_id: input.tenantId,
        rent_request_id: input.rentRequestId || null,
        outcome: input.outcome ?? outcomeForStatus(status),
        status,
        follow_up_at: input.followUpAt || null,
        comment: input.comment?.trim() ? input.comment.trim() : null,
        called_by: uid,
      });
      if (error) throw error;
      return status;
    },
    onSuccess: (status, vars) => {
      qc.invalidateQueries({ queryKey: ['tenant-call-summaries'] });
      qc.invalidateQueries({ queryKey: ['tenant-call-history', vars.tenantId] });
      qc.invalidateQueries({ queryKey: ['tenant-call-records'] });
      toast.success(
        status === 'missed'
          ? 'Call logged — tenant not reached'
          : status === 'closed'
            ? 'Call logged — closed'
            : 'Call logged — pending follow-up',
      );
    },
    onError: (e: any) => toast.error(e?.message || 'Could not log the call'),
  });
}
