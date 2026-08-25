import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

/**
 * Landlord Ops call tracking (append-only).
 *
 * `landlord_call_reports` rows are never updated or deleted — each call attempt
 * is a new row, so the full history is preserved. `v_landlord_call_summary`
 * gives the per-landlord rollup used by the Landlord Calling Hub and its
 * reports. Nothing about landlord, house or payout logic is touched here.
 */

export type LandlordCallStatus = 'pending' | 'closed' | 'missed';

export const LANDLORD_CALL_STATUS_LABEL: Record<LandlordCallStatus, string> = {
  pending: 'Pending',
  closed: 'Closed',
  missed: 'Missed',
};

export const landlordCallStatusBadgeClass = (status: LandlordCallStatus) =>
  status === 'closed'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
    : status === 'missed'
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-600';

export interface LandlordCallSummary {
  landlord_id: string;
  call_count: number;
  last_call_at: string | null;
  last_status: LandlordCallStatus | null;
  pending_count: number;
  closed_count: number;
  missed_count: number;
  latest_comment: string | null;
  latest_comment_at: string | null;
  last_follow_up_at: string | null;
}

export interface LandlordCallRecord {
  id: string;
  landlord_id: string;
  house_listing_id: string | null;
  status: LandlordCallStatus;
  comment: string | null;
  follow_up_at: string | null;
  called_by: string;
  called_at: string;
}

/** All-time call rollup for every landlord that has ever been called. */
export function useLandlordCallSummaries() {
  return useQuery({
    queryKey: ['landlord-call-summaries'],
    queryFn: async () => {
      const all: LandlordCallSummary[] = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        const { data, error } = await (supabase as any)
          .from('v_landlord_call_summary')
          .select('*')
          .range(from, from + page - 1);
        if (error) throw error;
        all.push(...((data || []) as LandlordCallSummary[]));
        if (!data || data.length < page) break;
      }
      const map = new Map<string, LandlordCallSummary>();
      all.forEach(r => map.set(r.landlord_id, r));
      return map;
    },
    staleTime: 60000,
  });
}

/** Full, untruncated call history for one landlord (newest first). */
export function useLandlordCallHistory(landlordId?: string | null) {
  return useQuery({
    queryKey: ['landlord-call-history', landlordId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('landlord_call_reports')
        .select('id, landlord_id, house_listing_id, status, follow_up_at, comment, called_by, called_at')
        .eq('landlord_id', landlordId)
        .order('called_at', { ascending: false });
      if (error) throw error;
      return (data || []) as LandlordCallRecord[];
    },
    enabled: !!landlordId,
    staleTime: 30000,
  });
}

/**
 * Every landlord call record inside a date window — the source for the Calling
 * Hub reports and exports. Paged so nothing is silently truncated.
 */
export function useLandlordCallRecords(fromISO?: string | null, toISO?: string | null) {
  return useQuery({
    queryKey: ['landlord-call-records', fromISO, toISO],
    queryFn: async () => {
      const all: LandlordCallRecord[] = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        let q = (supabase as any)
          .from('landlord_call_reports')
          .select('id, landlord_id, house_listing_id, status, follow_up_at, comment, called_by, called_at')
          .order('called_at', { ascending: false })
          .range(from, from + page - 1);
        if (fromISO) q = q.gte('called_at', fromISO);
        if (toISO) q = q.lte('called_at', toISO);
        const { data, error } = await q;
        if (error) throw error;
        all.push(...((data || []) as LandlordCallRecord[]));
        if (!data || data.length < page) break;
      }
      return all;
    },
    staleTime: 30000,
  });
}

export function useLogLandlordCall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      landlordId: string;
      status: LandlordCallStatus;
      comment?: string | null;
      houseListingId?: string | null;
      followUpAt?: string | null;
    }) => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error('You must be signed in to log a call.');
      const { error } = await (supabase as any).from('landlord_call_reports').insert({
        landlord_id: input.landlordId,
        house_listing_id: input.houseListingId || null,
        status: input.status,
        follow_up_at: input.followUpAt || null,
        comment: input.comment?.trim() ? input.comment.trim() : null,
        called_by: uid,
      });
      if (error) throw error;
      return input.status;
    },
    onSuccess: (status, vars) => {
      qc.invalidateQueries({ queryKey: ['landlord-call-summaries'] });
      qc.invalidateQueries({ queryKey: ['landlord-call-history', vars.landlordId] });
      qc.invalidateQueries({ queryKey: ['landlord-call-records'] });
      toast.success(
        status === 'missed'
          ? 'Call logged — landlord not reached'
          : status === 'closed'
            ? 'Call logged — closed'
            : 'Call logged — pending follow-up',
      );
    },
    onError: (e: any) => toast.error(e?.message || 'Could not log the call'),
  });
}
