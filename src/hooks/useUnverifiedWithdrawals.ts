import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Admin-only view of open withdrawal requests whose owners have NOT completed
 * ID verification. These rows are deliberately invisible to merchant agents
 * (the merchant queue, auto-dispatch and claim RPC all gate on the same
 * verification rule) — this hook is how office staff still see them.
 */

export const UNVERIFIED_WITHDRAWALS_PAGE_SIZE = 20;

/** Badge status filter — mirrors the colourblind-friendly badges on screen. */
export type UnverifiedBadgeFilter = 'all' | 'pending' | 'needs_review' | 'verified';
export type UnverifiedSort = 'newest' | 'oldest' | 'biggest' | 'smallest';

export interface UnverifiedWithdrawalRow {
  id: string;
  user_id: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  amount: number;
  status: string;
  payout_method: string;
  mobile_money_number: string | null;
  mobile_money_provider: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  created_at: string;
  hidden_from_merchant_queue: boolean | null;
  has_national_id: boolean;
  has_id_photo: boolean;
  has_selfie: boolean;
  destination_verified: boolean;
  badge: 'pending' | 'needs_review' | 'verified';
  total_count: number;
}

/** Human label + one-word status for the badge. */
export function badgeLabel(badge: UnverifiedWithdrawalRow['badge']): string {
  if (badge === 'verified') return 'Verified';
  if (badge === 'needs_review') return 'Needs review';
  return 'Pending';
}

/** Plain-language list of what the person still needs to submit. */
export function missingPieces(r: UnverifiedWithdrawalRow): string[] {
  const missing: string[] = [];
  if (!r.has_national_id) missing.push('National ID number');
  if (!r.has_id_photo) missing.push('National ID photo');
  if (!r.has_selfie) missing.push('Selfie');
  if (!r.destination_verified) missing.push('Payout number not verified');
  return missing;
}

export function useUnverifiedWithdrawals(
  search: string,
  page: number,
  filter: UnverifiedBadgeFilter = 'all',
  sort: UnverifiedSort = 'newest',
) {
  return useQuery({
    queryKey: ['finops-unverified-withdrawals', search, page, filter, sort],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('finops_unverified_withdrawals' as never, {
        p_search: search,
        p_limit: UNVERIFIED_WITHDRAWALS_PAGE_SIZE,
        p_offset: page * UNVERIFIED_WITHDRAWALS_PAGE_SIZE,
        p_filter: filter,
        p_sort: sort,
      } as never);
      if (error) throw error;
      const rows = (data as unknown as UnverifiedWithdrawalRow[]) ?? [];
      return { rows, total: rows.length > 0 ? Number(rows[0].total_count) : 0 };
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
}
