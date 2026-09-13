/**
 * User location corrections — data layer.
 *
 * Deliberately a thin extension of the existing tenant correction system, not a
 * second one:
 *  - "unmapped" is the same rule (`profiles.ug_village_id IS NULL`);
 *  - the approved options come from the same Uganda dataset (UgLocationPicker);
 *  - the write goes through the same RPC, `correct_tenant_location`, which now
 *    also accepts a caller correcting their own profile row.
 *
 * Because a user and a tenant are the SAME `profiles` row, a system user who is
 * also a tenant has exactly one location record — correcting it once satisfies
 * both surfaces. Nothing here creates, merges or deletes any record.
 *
 * RPCs:
 *  - my_location_correction_status()                      ← self, any signed-in user
 *  - user_location_corrections(p_search, p_status, ...)   ← ops monitoring list
 *  - user_location_correction_progress()                  ← ops monitoring totals
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { TENANT_LOCATION_KEYS } from '@/hooks/useTenantLocationCorrections';

export type UserCorrectionStatus = 'unmapped' | 'pending' | 'corrected';

export interface MyLocationCorrectionStatus {
  user_id?: string;
  full_name?: string | null;
  phone?: string | null;
  needs_correction: boolean;
  is_tenant: boolean;
  ug_village_id?: number | null;
  legacy_region?: string | null;
  legacy_district?: string | null;
  legacy_sub_county?: string | null;
  legacy_parish?: string | null;
  legacy_village?: string | null;
  roles?: string[];
}

export interface UserLocationCorrectionRow {
  user_id: string;
  full_name: string | null;
  phone: string | null;
  roles: string[] | null;
  is_tenant: boolean;
  legacy_region: string | null;
  legacy_district: string | null;
  legacy_sub_county: string | null;
  legacy_parish: string | null;
  legacy_village: string | null;
  ug_village_id: number | null;
  approved_path: string | null;
  correction_status: UserCorrectionStatus;
  corrected_at: string | null;
  corrected_by: string | null;
  corrected_by_name: string | null;
  total_count: number;
}

export interface UserLocationProgress {
  total_users: number;
  corrected: number;
  pending: number;
  unmapped: number;
  outstanding: number;
  also_tenants: number;
  also_tenants_outstanding: number;
}

export const USER_LOCATION_KEYS = {
  mine: 'my-location-correction-status',
  list: 'user-location-corrections',
  progress: 'user-location-correction-progress',
} as const;

/** Human label for whatever location text is currently on record. */
export function userLegacyLabel(row: {
  legacy_village?: string | null;
  legacy_parish?: string | null;
  legacy_sub_county?: string | null;
  legacy_district?: string | null;
  legacy_region?: string | null;
}) {
  const parts = [row.legacy_village, row.legacy_parish, row.legacy_sub_county, row.legacy_district, row.legacy_region]
    .map((v) => (v ?? '').trim())
    .filter(Boolean);
  return parts.length ? parts.join(', ') : 'No location on record';
}

export function useMyLocationCorrectionStatus(enabled = true) {
  return useQuery({
    queryKey: [USER_LOCATION_KEYS.mine],
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<MyLocationCorrectionStatus> => {
      const { data, error } = await supabase.rpc('my_location_correction_status' as any);
      if (error) throw error;
      return (data ?? { needs_correction: false, is_tenant: false }) as unknown as MyLocationCorrectionStatus;
    },
  });
}

export function useUserLocationProgress(enabled = true) {
  return useQuery({
    queryKey: [USER_LOCATION_KEYS.progress],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<UserLocationProgress> => {
      const { data, error } = await supabase.rpc('user_location_correction_progress' as any);
      if (error) throw error;
      return (data ?? {}) as unknown as UserLocationProgress;
    },
  });
}

export function useUserLocationCorrections(opts: {
  search?: string;
  status?: UserCorrectionStatus | 'all';
  page?: number;
  pageSize?: number;
  enabled?: boolean;
}) {
  const { search = '', status = 'all', page = 0, pageSize = 25, enabled = true } = opts;
  return useQuery({
    queryKey: [USER_LOCATION_KEYS.list, search.trim(), status, page, pageSize],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('user_location_corrections' as any, {
        p_search: search.trim() || null,
        p_status: status === 'all' ? null : status,
        p_limit: pageSize,
        p_offset: page * pageSize,
      });
      if (error) throw error;
      const rows = (data ?? []) as UserLocationCorrectionRow[];
      return { rows, total: rows[0]?.total_count ?? 0 };
    },
  });
}

/** Invalidate both the user and the tenant correction views — one shared record. */
export function useInvalidateLocationCorrections() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: [USER_LOCATION_KEYS.mine] });
    qc.invalidateQueries({ queryKey: [USER_LOCATION_KEYS.list] });
    qc.invalidateQueries({ queryKey: [USER_LOCATION_KEYS.progress] });
    qc.invalidateQueries({ queryKey: [TENANT_LOCATION_KEYS.list] });
    qc.invalidateQueries({ queryKey: [TENANT_LOCATION_KEYS.progress] });
    qc.invalidateQueries({ queryKey: [TENANT_LOCATION_KEYS.dashboard] });
  };
}

/** Kept for symmetry: the write is the existing tenant RPC with the caller's own id. */
export function useCorrectMyLocation() {
  const invalidate = useInvalidateLocationCorrections();
  return useMutation({
    mutationFn: async (vars: { userId: string; villageId: number; reason?: string }) => {
      const { data, error } = await supabase.rpc('correct_tenant_location' as any, {
        p_tenant_id: vars.userId,
        p_village_id: vars.villageId,
        p_reason: vars.reason ?? 'Own location corrected to the approved Uganda location dataset',
      });
      if (error) throw error;
      return data as { success: boolean; full_path?: string };
    },
    onSuccess: invalidate,
  });
}
