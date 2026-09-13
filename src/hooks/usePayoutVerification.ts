/**
 * Payout destination verification — Financial Ops queue + decisions.
 *
 * Every mobile money number and bank account a user can be paid to must be
 * verified by Financial Ops before any withdrawal to it is allowed. The gate
 * itself lives in the database (`submit_withdrawal_request`, the
 * `enforce_withdrawal_destination_verified` trigger and the approve-withdrawal
 * edge function). These hooks are read + decide only; nothing here writes the
 * table directly.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type PayoutVerificationStatus = 'waiting' | 'verified' | 'rejected';
export type PayoutQueueFilter = PayoutVerificationStatus | 'all' | 'mismatch' | 'no_id';
export type PayoutQueueSort = 'oldest' | 'balance';

export interface PayoutDestinationRow {
  id: string;
  user_id: string;
  full_name: string | null;
  user_phone: string | null;
  destination_type: 'mobile_money' | 'bank_transfer';
  provider: string | null;
  momo_number: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  account_name: string | null;
  national_id: string | null;
  national_id_name: string | null;
  name_match_score: number | null;
  name_mismatch_tokens: string[] | null;
  status: PayoutVerificationStatus;
  decision_reason: string | null;
  call_outcome: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  first_seen_at: string;
  withdrawable_balance: number;
  total_count: number;
}

export interface PayoutVerificationCounts {
  waiting: number;
  verified: number;
  rejected: number;
  mismatch: number;
  no_id: number;
  waiting_balance: number;
}

export const PAYOUT_VERIFICATION_PAGE_SIZE = 20;

/** Live counts for the badge and the filter chips. */
export function usePayoutVerificationCounts(enabled = true) {
  return useQuery({
    queryKey: ['payout-verification-counts'],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<PayoutVerificationCounts> => {
      const { data, error } = await supabase.rpc('finops_payout_verification_counts');
      if (error) throw error;
      const row = (data ?? {}) as Partial<PayoutVerificationCounts>;
      return {
        waiting: Number(row.waiting ?? 0),
        verified: Number(row.verified ?? 0),
        rejected: Number(row.rejected ?? 0),
        mismatch: Number(row.mismatch ?? 0),
        no_id: Number(row.no_id ?? 0),
        waiting_balance: Number(row.waiting_balance ?? 0),
      };
    },
  });
}

/** One page of destinations for the given filter/search/sort. */
export function usePayoutVerificationQueue(opts: {
  status: PayoutQueueFilter;
  search: string;
  sort: PayoutQueueSort;
  page: number;
  enabled?: boolean;
}) {
  const { status, search, sort, page, enabled = true } = opts;
  return useQuery({
    queryKey: ['payout-verification-queue', status, search, sort, page],
    enabled,
    queryFn: async (): Promise<{ rows: PayoutDestinationRow[]; total: number }> => {
      const { data, error } = await supabase.rpc('finops_payout_verification_queue', {
        p_status: status,
        p_search: search.trim() || null,
        p_sort: sort,
        p_limit: PAYOUT_VERIFICATION_PAGE_SIZE,
        p_offset: page * PAYOUT_VERIFICATION_PAGE_SIZE,
      });
      if (error) throw error;
      const rows = ((data ?? []) as unknown[]).map((r) => {
        const row = r as Record<string, unknown>;
        const tokens = row.name_mismatch_tokens;
        return {
          ...(row as unknown as PayoutDestinationRow),
          name_match_score: row.name_match_score === null ? null : Number(row.name_match_score),
          withdrawable_balance: Number(row.withdrawable_balance ?? 0),
          total_count: Number(row.total_count ?? 0),
          name_mismatch_tokens: Array.isArray(tokens) ? (tokens as string[]) : [],
        } as PayoutDestinationRow;
      });
      return { rows, total: rows[0]?.total_count ?? 0 };
    },
  });
}

/** Verify or reject one destination. Reason is mandatory (10+ characters). */
export function useDecidePayoutDestination() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      decision: 'verified' | 'rejected';
      reason: string;
      callOutcome?: string;
    }) => {
      const { data, error } = await supabase.rpc('finops_decide_payout_destination', {
        p_id: input.id,
        p_decision: input.decision,
        p_reason: input.reason,
        p_call_outcome: input.callOutcome ?? null,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payout-verification-queue'] });
      qc.invalidateQueries({ queryKey: ['payout-verification-counts'] });
    },
  });
}

/** The signed-in user's own National ID submission. */
export function useSubmitNationalId() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { nationalId: string; idName: string }) => {
      const { data, error } = await supabase.rpc('submit_national_id', {
        p_national_id: input.nationalId,
        p_id_name: input.idName,
      });
      if (error) throw new Error(error.message);
      const res = (data ?? {}) as { success?: boolean; message?: string };
      if (!res.success) throw new Error(res.message || 'Could not save your National ID.');
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['my-payout-destinations'] });
    },
  });
}

export interface MyPayoutDestination {
  id: string;
  destination_type: 'mobile_money' | 'bank_transfer';
  provider: string | null;
  momo_number: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  account_name: string | null;
  status: PayoutVerificationStatus;
  decision_reason: string | null;
  decided_at: string | null;
  national_id_submitted_at: string | null;
  first_seen_at: string | null;
}

/**
 * The signed-in user's own destinations and their verification state, so the
 * withdraw screen can show "Verified" / "Waiting for verification" per saved
 * destination instead of failing at submit time.
 */
export function useMyPayoutDestinations(userId?: string | null) {
  return useQuery({
    queryKey: ['my-payout-destinations', userId],
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: async (): Promise<MyPayoutDestination[]> => {
      const { data, error } = await supabase
        .from('payout_destination_verifications')
        .select(
          'id, destination_type, provider, momo_number, bank_name, bank_account_number, account_name, status, decision_reason, decided_at, national_id_submitted_at, first_seen_at',
        )
        .eq('user_id', userId as string)
        // Newest submitted National ID first — matches the FinOps queue so the
        // withdraw prompt and the review queue always tell the same story.
        .order('national_id_submitted_at', { ascending: false, nullsFirst: false })
        .order('first_seen_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as unknown as MyPayoutDestination[];
    },
  });
}

/** Last 9 digits — the platform-wide way of comparing Ugandan numbers. */
export function last9(value?: string | null): string {
  return (value ?? '').replace(/\D/g, '').slice(-9);
}

/** Verification state for one destination out of the user's own list. */
export function destinationStateFor(
  list: MyPayoutDestination[] | undefined,
  input: { mode: 'mobile_money' | 'bank_transfer' | 'cash'; momoNumber?: string | null; bankAccountNumber?: string | null },
): MyPayoutDestination | null {
  if (!list || input.mode === 'cash') return null;
  if (input.mode === 'mobile_money') {
    const key = last9(input.momoNumber);
    if (!key) return null;
    return list.find((d) => d.destination_type === 'mobile_money' && last9(d.momo_number) === key) ?? null;
  }
  const acct = (input.bankAccountNumber ?? '').replace(/\D/g, '');
  if (!acct) return null;
  return (
    list.find(
      (d) => d.destination_type === 'bank_transfer' && (d.bank_account_number ?? '').replace(/\D/g, '') === acct,
    ) ?? null
  );
}
