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
      qc.invalidateQueries({ queryKey: ['payout-decision-log'] });
    },
  });
}

/** One decision entry for the Financial Ops audit log. */
export interface PayoutDecisionLogRow {
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
  status: PayoutVerificationStatus;
  decision_reason: string | null;
  decided_by_name: string | null;
  decided_at: string;
}

export interface PayoutDecisionLogFilters {
  search?: string;
  decision?: 'verified' | 'rejected' | 'all';
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
}

export const PAYOUT_DECISION_LOG_PAGE_SIZE = 20;

/**
 * One page of the newest-first record of every verify/reject decision,
 * searchable by holder name, number or decider, filterable by decision and
 * decision date. Returns the matching total so the UI can page large
 * histories.
 */
export function usePayoutDecisionLog(
  enabled: boolean,
  filters: PayoutDecisionLogFilters,
  page: number,
) {
  const search = (filters.search ?? '').trim();
  const decision = filters.decision && filters.decision !== 'all' ? filters.decision : null;
  const from = filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : null;
  const to = filters.to ? new Date(`${filters.to}T00:00:00`).toISOString() : null;
  return useQuery({
    queryKey: ['payout-decision-log', search, decision, filters.from ?? '', filters.to ?? '', page],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<{ rows: PayoutDecisionLogRow[]; total: number }> => {
      const rpcArgs = { p_search: search || null, p_decision: decision, p_from: from, p_to: to };
      const [rowsRes, countRes] = await Promise.all([
        supabase.rpc('finops_payout_decision_log', {
          ...rpcArgs,
          p_limit: PAYOUT_DECISION_LOG_PAGE_SIZE,
          p_offset: page * PAYOUT_DECISION_LOG_PAGE_SIZE,
        }),
        supabase.rpc('finops_payout_decision_log_count', rpcArgs),
      ]);
      if (rowsRes.error) throw rowsRes.error;
      if (countRes.error) throw countRes.error;
      return {
        rows: (rowsRes.data ?? []) as unknown as PayoutDecisionLogRow[],
        total: Number(countRes.data ?? 0),
      };
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
          'id, destination_type, provider, momo_number, bank_name, bank_account_number, account_name, status, decision_reason, decided_at',
        )
        .eq('user_id', userId as string);
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
