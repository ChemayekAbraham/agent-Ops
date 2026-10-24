import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface LandlordRegistryRecord {
  landlord_key: string;
  landlord_id: string | null;
  user_id: string | null;
  full_name: string | null;
  phones: string[] | null;
  region: string | null;
  district: string | null;
  registering_agent_id: string | null;
  registering_agent_name: string | null;
  houses_count: number;
  active_rent_plans: number;
  total_paid_out_ugx: number;
  last_payout_at: string | null;
  registered_at: string | null;
  verification_status: string | null;
  last_called_at: string | null;
  last_call_outcome: string | null;
  last_caller_name: string | null;
  needs_review: boolean;
  plan_rent_total: number;
}

export interface LandlordSavedQueue {
  id: string;
  name: string;
  filters: Record<string, any>;
  sort_key: string | null;
  owner: string;
  owner_name: string | null;
  shared: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Resolve a single landlord registry entry by subjectId (which may be either
 * `landlord_id` or `user_id` depending on which population populated the cycle row).
 */
export async function fetchLandlordRegistryEntry(subjectId: string): Promise<LandlordRegistryRecord | null> {
  if (!subjectId) return null;
  const { data, error } = await (supabase as any)
    .from('v_landlord_registry_all')
    .select('*')
    .or(`landlord_id.eq.${subjectId},user_id.eq.${subjectId}`)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data as LandlordRegistryRecord;
}

export function useLandlordRegistryEntry(subjectId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['landlord-registry-entry', subjectId],
    enabled: Boolean(subjectId) && enabled,
    staleTime: 30_000,
    queryFn: () => fetchLandlordRegistryEntry(subjectId!),
  });
}

/**
 * Batch-resolve `v_landlord_registry_all` rows for the current page of queue `subject_id`s.
 * Returns a lookup map keyed by both `landlord_id` and `user_id` so any `row.subject_id` matches.
 */
export function useLandlordRegistryBatch(subjectIds: string[]) {
  const uniqueIds = Array.from(new Set(subjectIds.filter(Boolean))).sort();
  return useQuery({
    queryKey: ['landlord-registry-batch', uniqueIds],
    enabled: uniqueIds.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, LandlordRegistryRecord>> => {
      if (uniqueIds.length === 0) return {};
      const [{ data: byLandlordId }, { data: byUserId }] = await Promise.all([
        (supabase as any)
          .from('v_landlord_registry_all')
          .select('*')
          .in('landlord_id', uniqueIds),
        (supabase as any)
          .from('v_landlord_registry_all')
          .select('*')
          .in('user_id', uniqueIds),
      ]);

      const map: Record<string, LandlordRegistryRecord> = {};
      for (const r of [...(byLandlordId ?? []), ...(byUserId ?? [])] as LandlordRegistryRecord[]) {
        if (r.landlord_id) map[r.landlord_id] = r;
        if (r.user_id) map[r.user_id] = r;
      }
      return map;
    },
  });
}

export function useLandlordSavedQueues() {
  return useQuery({
    queryKey: ['landlord-cc-saved-queues'],
    staleTime: 30_000,
    queryFn: async (): Promise<LandlordSavedQueue[]> => {
      const { data, error } = await (supabase.rpc as any)('landlord_cc_list_queues');
      if (error) throw error;
      return (data ?? []) as LandlordSavedQueue[];
    },
  });
}

export function useSaveLandlordQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      filters: Record<string, any>;
      sortKey?: string | null;
      shared?: boolean;
      queueId?: string | null;
    }) => {
      const { data, error } = await (supabase.rpc as any)('landlord_cc_save_queue', {
        p_name: input.name,
        p_filters: input.filters,
        p_sort_key: input.sortKey ?? null,
        p_shared: input.shared ?? false,
        p_queue_id: input.queueId ?? null,
      });
      if (error) throw error;
      return data as LandlordSavedQueue;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['landlord-cc-saved-queues'] });
    },
  });
}

export function useAssignLandlordCallers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { cycleId: string; staffIds: string[] }) => {
      const { data, error } = await (supabase.rpc as any)('landlord_cc_assign_callers', {
        p_cycle_id: input.cycleId,
        p_staff_ids: input.staffIds,
      });
      if (error) throw error;
      return data as { cycle_id: string; assigned_rows: number; staff_count: number };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cc-queue'] });
    },
  });
}
