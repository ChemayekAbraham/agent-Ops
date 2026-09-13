import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Payout-destination verification.
 *
 * Nobody is paid to a phone number or bank account that Financial Ops has not
 * personally confirmed, and every wallet holder must have a National ID whose
 * name can be compared against that destination. All writes go through
 * SECURITY DEFINER RPCs (`submit_national_id`,
 * `finops_decide_payout_destination`) — the client never touches the
 * verification table directly.
 */

export type DestinationStatus = 'waiting' | 'verified' | 'rejected';

export interface PayoutQueueRow {
  id: string;
  user_id: string;
  full_name: string | null;
  user_phone: string | null;
  destination_type: string;
  provider: string | null;
  momo_number: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  account_name: string | null;
  national_id: string | null;
  national_id_name: string | null;
  name_match_score: number | null;
  name_mismatch_tokens: unknown;
  status: DestinationStatus;
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

export type QueueFilter = 'waiting' | 'verified' | 'rejected' | 'mismatch' | 'no_id' | 'all';
/** `newest` = most recently submitted National ID on top. */
export type QueueSort = 'newest' | 'oldest' | 'balance';

export const PAYOUT_VERIFICATION_PAGE_SIZE = 20;

export function usePayoutVerificationCounts() {
  return useQuery({
    queryKey: ['payout-verification-counts'],
    queryFn: async (): Promise<PayoutVerificationCounts> => {
      const { data, error } = await supabase.rpc('finops_payout_verification_counts');
      if (error) throw error;
      const d = (data ?? {}) as Record<string, unknown>;
      const n = (k: string) => Number(d[k] ?? 0) || 0;
      return {
        waiting: n('waiting'),
        verified: n('verified'),
        rejected: n('rejected'),
        mismatch: n('mismatch'),
        no_id: n('no_id'),
        waiting_balance: n('waiting_balance'),
      };
    },
    staleTime: 30_000,
  });
}

export function usePayoutVerificationQueue(opts: {
  status: QueueFilter;
  search: string;
  sort: QueueSort;
  page: number;
  enabled?: boolean;
}) {
  const { status, search, sort, page } = opts;
  return useQuery({
    queryKey: ['payout-verification-queue', status, search, sort, page],
    enabled: opts.enabled !== false,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('finops_payout_verification_queue', {
        p_status: status,
        p_search: search.trim() || undefined,
        p_sort: sort,
        p_limit: PAYOUT_VERIFICATION_PAGE_SIZE,
        p_offset: page * PAYOUT_VERIFICATION_PAGE_SIZE,
      });
      if (error) throw error;
      const rows = (data ?? []) as unknown as PayoutQueueRow[];
      return { rows, total: rows.length ? Number(rows[0].total_count) || 0 : 0 };
    },
  });
}

export function useDecidePayoutDestination() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      decision: 'verified' | 'rejected';
      reason: string;
      callOutcome?: string;
    }) => {
      if (input.reason.trim().length < 10) {
        throw new Error('Write at least 10 characters explaining the decision.');
      }
      const { data, error } = await supabase.rpc('finops_decide_payout_destination', {
        p_id: input.id,
        p_decision: input.decision,
        p_reason: input.reason.trim(),
        p_call_outcome: input.callOutcome?.trim() || undefined,
      });
      if (error) throw error;
      const res = (data ?? {}) as { success?: boolean; message?: string };
      if (res.success === false) throw new Error(res.message || 'Could not save the decision.');
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payout-verification-queue'] });
      qc.invalidateQueries({ queryKey: ['payout-verification-counts'] });
    },
  });
}

/** The signed-in user's own recorded National ID, if any. */
export function useMyNationalId(userId?: string | null) {
  return useQuery({
    queryKey: ['my-national-id', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('national_id, national_id_name')
        .eq('id', userId as string)
        .maybeSingle();
      if (error) throw error;
      const nid = String((data as { national_id?: string | null } | null)?.national_id ?? '').trim();
      return {
        nationalId: nid || null,
        nationalIdName:
          String((data as { national_id_name?: string | null } | null)?.national_id_name ?? '').trim() || null,
        submitted: !!nid,
      };
    },
    staleTime: 60_000,
  });
}

export function useSubmitNationalId() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { nationalId: string; idName: string }) => {
      const { data, error } = await supabase.rpc('submit_national_id', {
        p_national_id: input.nationalId.trim(),
        p_id_name: input.idName.trim(),
      });
      if (error) throw error;
      const res = (data ?? {}) as { success?: boolean; message?: string };
      if (!res.success) throw new Error(res.message || 'Could not record your National ID.');
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-national-id'] });
      qc.invalidateQueries({ queryKey: ['my-payout-destinations'] });
      qc.invalidateQueries({ queryKey: ['payout-verification-counts'] });
    },
  });
}

export interface MyDestination {
  id: string;
  destination_type: string;
  provider: string | null;
  momo_number: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  account_name: string | null;
  status: DestinationStatus;
  decision_reason: string | null;
}

/** Read-only: the states of the signed-in user's own payout destinations. */
export function useMyPayoutDestinations(userId?: string | null) {
  return useQuery({
    queryKey: ['my-payout-destinations', userId],
    enabled: !!userId,
    queryFn: async (): Promise<MyDestination[]> => {
      const { data, error } = await supabase
        .from('payout_destination_verifications')
        .select(
          'id, destination_type, provider, momo_number, bank_name, bank_account_number, account_name, status, decision_reason',
        )
        .eq('user_id', userId as string);
      if (error) throw error;
      return (data ?? []) as unknown as MyDestination[];
    },
    staleTime: 30_000,
  });
}

/** Ugandan numbers are compared on their last 9 digits, platform-wide. */
export function last9(raw?: string | null): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.slice(-9);
}

/**
 * The verification state of the destination the user is about to be paid to.
 * Cash pickup has no destination to verify, so it returns null.
 */
export function destinationStateFor(
  list: MyDestination[] | undefined,
  target: { mode: string; momoNumber?: string; bankAccountNumber?: string },
): MyDestination | null {
  if (!list?.length) return null;
  if (target.mode === 'cash') return null;
  if (target.mode === 'mobile_money') {
    const key = last9(target.momoNumber);
    if (!key) return null;
    return list.find((d) => d.destination_type === 'mobile_money' && last9(d.momo_number) === key) ?? null;
  }
  if (target.mode === 'bank_transfer') {
    const acct = String(target.bankAccountNumber ?? '').replace(/\s/g, '');
    if (!acct) return null;
    return (
      list.find(
        (d) =>
          d.destination_type === 'bank_transfer' &&
          String(d.bank_account_number ?? '').replace(/\s/g, '') === acct,
      ) ?? null
    );
  }
  return null;
}
