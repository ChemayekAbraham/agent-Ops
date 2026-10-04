import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/** Supabase errors are plain objects — turn them into real Errors so the UI
 * never renders "[object Object]". */
function toError(error: any): Error {
  if (error instanceof Error) return error;
  const parts = [error?.message, error?.details, error?.hint].filter(Boolean);
  const code = error?.code ? ` (${error.code})` : '';
  return new Error((parts.join(' — ') || 'Unknown database error') + code);
}

export interface ServiceCenterLandlordRow {
  id: string;
  name: string | null;
  phone: string | null;
  village: string | null;
  district: string | null;
  property_address: string | null;
  monthly_rent: number | null;
  number_of_houses: number | null;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  service_center_status: string;
}

export interface ServiceCenterLc1Row {
  id: string;
  name: string | null;
  phone: string | null;
  village: string | null;
  district: string | null;
  parish: string | null;
  sub_county: string | null;
  created_at: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  service_center_status: string;
}

export interface ServiceCenterVerificationQueue {
  landlords: ServiceCenterLandlordRow[];
  lc1: ServiceCenterLc1Row[];
  pending_count: number;
}

/**
 * Landlords and LC1 chairpersons registered by this manager's verified team,
 * waiting on their vetting before Landlord Ops verifies them. The database
 * decides eligibility, never the client.
 */
export function useServiceCenterVerificationQueue() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['service-center-verification-queue', user?.id],
    enabled: !!user?.id,
    staleTime: 30_000,
    queryFn: async (): Promise<ServiceCenterVerificationQueue> => {
      const { data, error } = await (supabase.rpc as any)('get_service_center_verification_queue', {
        p_manager_id: user!.id,
      });
      if (error) throw toError(error);
      const row = (data ?? {}) as Partial<ServiceCenterVerificationQueue>;
      return {
        landlords: row.landlords ?? [],
        lc1: row.lc1 ?? [],
        pending_count: Number(row.pending_count ?? 0),
      };
    },
  });
}

export function useServiceCenterReviewVerification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      kind: 'landlord' | 'lc1';
      recordId: string;
      decision: 'pass' | 'return';
      comment?: string;
    }) => {
      const { data, error } = await (supabase.rpc as any)('service_center_review_verification', {
        p_kind: input.kind,
        p_record_id: input.recordId,
        p_decision: input.decision,
        p_comment: input.comment ?? null,
      });
      if (error) throw toError(error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-center-verification-queue'] });
    },
  });
}