import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type PayoutNumberReviewKind = 'approved_differs_from_record' | 'approved_number_missing' | 'not_verified_with_float';

export interface PayoutNumberReviewRow {
  landlord_id: string;
  landlord_name: string | null;
  verification_status: string | null;
  kind: PayoutNumberReviewKind;
  on_file_number: string | null;
  phone: string | null;
  approved_number: string | null;
  approved_source: string | null;
  approved_set_at: string | null;
  last_verified_request_number: string | null;
  open_allocations: number;
  open_float_remaining: number;
}

const KEY = ['landlord-payout-number-review'] as const;

function toError(error: any): Error {
  if (error instanceof Error) return error;
  const parts = [error?.message, error?.details, error?.hint].filter(Boolean);
  return new Error(parts.join(' - ') || 'Unknown database error');
}

/** Landlords whose approved payout number is missing or differs from the record, plus unverified landlords still holding float. */
export function useLandlordPayoutNumberReview(kind?: PayoutNumberReviewKind | null) {
  return useQuery({
    queryKey: [...KEY, kind ?? 'all'],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_landlord_payout_number_review', {
        p_kind: kind ?? null,
        p_limit: 200,
        p_offset: 0,
      });
      if (error) throw toError(error);
      return (data ?? []) as PayoutNumberReviewRow[];
    },
  });
}

/** Confirm one of the numbers already on the landlord's record as the approved payout number. */
export function useConfirmLandlordPayoutNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { landlordId: string; number: string; reason: string }) => {
      const { data, error } = await (supabase.rpc as any)('confirm_landlord_payout_number', {
        p_landlord_id: input.landlordId,
        p_number: input.number,
        p_reason: input.reason,
      });
      if (error) throw toError(error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY });
    },
  });
}
