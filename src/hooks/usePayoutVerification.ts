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
import { publishAvatarUpdate } from '@/lib/avatarSync';


export type PayoutVerificationStatus = 'waiting' | 'verified' | 'rejected';
export type PayoutQueueFilter = PayoutVerificationStatus | 'all' | 'mismatch' | 'no_id' | 'double';
export type PayoutQueueSort = 'ready_first' | 'newest' | 'oldest' | 'balance';

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
  /** 'national_id' = shown name adopted from the ID; 'verified' = name set by a reviewer; null = untouched. */
  name_source: 'national_id' | 'verified' | null;
  /** True when this account is NOT the first holder of its National ID or phone number. */
  double_submission: boolean;
  double_kind: 'national_id' | 'phone' | null;
  double_of_user_id: string | null;
  double_of_name: string | null;
  total_count: number;
}

export interface PayoutVerificationCounts {
  waiting: number;
  verified: number;
  rejected: number;
  mismatch: number;
  no_id: number;
  double: number;
  waiting_balance: number;
}

export const PAYOUT_VERIFICATION_PAGE_SIZE = 20;

/** Turns a server error into a plain sentence a reviewer can act on. */
export function payoutQueueErrorMessage(raw: string | null | undefined): string {
  const m = (raw ?? '').toLowerCase();
  if (m.includes('financial ops only')) {
    return 'This account is not allowed to review payouts. Ask for the Financial Ops permission to be switched on for the account you are signed in with, then sign out and back in.';
  }
  if (m.includes('jwt') || m.includes('not authenticated') || m.includes('invalid claim')) {
    return 'Your session has expired. Sign out and sign back in, then open this page again.';
  }
  if (m.includes('timeout') || m.includes('canceling statement')) {
    return 'The list took too long to load. Narrow it with a date range or a search, then try again.';
  }
  if (m.includes('failed to fetch') || m.includes('network')) {
    return 'No connection to the server. Check the internet and try again.';
  }
  return raw || 'Something went wrong while loading the list.';
}

/** Live counts for the badge and the filter chips. */
export function usePayoutVerificationCounts(enabled = true) {
  return useQuery({
    queryKey: ['payout-verification-counts'],
    enabled,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<PayoutVerificationCounts> => {
      const { data, error } = await supabase.rpc('finops_payout_verification_counts');
      if (error) throw new Error(payoutQueueErrorMessage(error.message));
      const row = (data ?? {}) as Partial<PayoutVerificationCounts>;
      return {
        waiting: Number(row.waiting ?? 0),
        verified: Number(row.verified ?? 0),
        rejected: Number(row.rejected ?? 0),
        mismatch: Number(row.mismatch ?? 0),
        no_id: Number(row.no_id ?? 0),
        double: Number(row.double ?? 0),
        waiting_balance: Number(row.waiting_balance ?? 0),
      };
    },
  });
}

/** Person-type filter for the queue: funders (hold a portfolio), tenants, or everyone else. */
export type PayoutQueueUserType = 'all' | 'funder' | 'tenant' | 'other';

/** One page of destinations for the given filter/search/sort. */
export function usePayoutVerificationQueue(opts: {
  status: PayoutQueueFilter;
  search: string;
  sort: PayoutQueueSort;
  page: number;
  dateFrom?: string | null;
  dateTo?: string | null;
  userType?: PayoutQueueUserType;
  enabled?: boolean;
}) {
  const { status, search, sort, page, dateFrom, dateTo, userType = 'all', enabled = true } = opts;
  return useQuery({
    queryKey: ['payout-verification-queue', status, search, sort, page, dateFrom, dateTo, userType],
    enabled,
    retry: false,
    queryFn: async (): Promise<{ rows: PayoutDestinationRow[]; total: number }> => {
      const { data, error } = await supabase.rpc('finops_payout_verification_queue', {
        p_status: status,
        p_search: search.trim() || null,
        p_sort: sort,
        p_limit: PAYOUT_VERIFICATION_PAGE_SIZE,
        p_offset: page * PAYOUT_VERIFICATION_PAGE_SIZE,
        p_date_from: dateFrom || null,
        p_date_to: dateTo || null,
        p_user_type: userType === 'all' ? null : userType,
      });
      if (error) throw new Error(payoutQueueErrorMessage(error.message));
      const rows = ((data ?? []) as unknown[]).map((r) => {
        const row = r as Record<string, unknown>;
        const tokens = row.name_mismatch_tokens;
        return {
          ...(row as unknown as PayoutDestinationRow),
          name_match_score: row.name_match_score === null ? null : Number(row.name_match_score),
          withdrawable_balance: Number(row.withdrawable_balance ?? 0),
          total_count: Number(row.total_count ?? 0),
          name_mismatch_tokens: Array.isArray(tokens) ? (tokens as string[]) : [],
          double_submission: row.double_submission === true,
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
      /** Holder — used to apply their verified selfie as the profile picture. */
      userId?: string;
    }) => {
      const { data, error } = await supabase.rpc('finops_decide_payout_destination', {
        p_id: input.id,
        p_decision: input.decision,
        p_reason: input.reason,
        p_call_outcome: input.callOutcome ?? null,
      });
      if (error) throw new Error(error.message);

      // The moment a selfie is verified it becomes the holder's profile picture.
      // Best-effort: never fails the decision itself.
      if (input.decision === 'verified' && input.userId) {
        try {
          const res = await supabase.functions.invoke('apply-verified-selfie-avatar', {
            body: { userId: input.userId },
          });
          const url = (res.data as { avatar_url?: string } | null)?.avatar_url;
          if (url) publishAvatarUpdate(input.userId, url);
        } catch { /* profile picture update is best-effort */ }
      }

      return { ...((data ?? {}) as Record<string, unknown>), id: input.id } as {
        id: string;
        status?: string;
        full_name?: string | null;
        name_source?: string | null;
      };
    },
    onSuccess: (data) => {
      // Show the adopted verified name on the row instantly, before the
      // refetch lands, so the operator sees the result without waiting.
      const newName = typeof data?.full_name === 'string' ? data.full_name : null;
      const newSource = data?.name_source === 'national_id' || data?.name_source === 'verified'
        ? (data.name_source as PayoutDestinationRow['name_source'])
        : null;
      const newStatus = typeof data?.status === 'string' ? data.status : null;
      if (newName || newStatus) {
        qc.setQueriesData<{ rows: PayoutDestinationRow[]; total: number }>(
          { queryKey: ['payout-verification-queue'] },
          (old) =>
            old
              ? {
                  ...old,
                  rows: old.rows.map((r) =>
                    r.id === data.id
                      ? {
                          ...r,
                          ...(newName ? { full_name: newName } : {}),
                          ...(newSource ? { name_source: newSource } : {}),
                          ...(newStatus === 'verified' || newStatus === 'rejected'
                            ? { status: newStatus as PayoutDestinationRow['status'] }
                            : {}),
                        }
                      : r,
                  ),
                }
              : old,
        );
      }
      qc.invalidateQueries({ queryKey: ['payout-verification-queue'] });
      qc.invalidateQueries({ queryKey: ['payout-verification-counts'] });
      qc.invalidateQueries({ queryKey: ['payout-decision-log'] });
      // A verified decision also adopts the National ID name as the profile name.
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['holder-name-history'] });
    },
  });
}

/**
 * Adopt the name printed on the National ID as the holder's name.
 * Finance-gated inside the database; the profile write happens there.
 */
export function useAdoptNationalIdName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; reason?: string }) => {
      const { data, error } = await supabase.rpc('finops_adopt_national_id_name', {
        p_id: input.id,
        p_reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as { success?: boolean; full_name?: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payout-verification-queue'] });
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['holder-name-history'] });
    },
  });
}




/**
 * Manual override: Financial Ops confirms or corrects the final holder name
 * before the payout is marked verified. Finance-gated inside the database.
 */
export function useSetHolderName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; fullName: string; reason?: string; applyNow?: boolean }) => {
      const { data, error } = await supabase.rpc('finops_set_holder_name', {
        p_id: input.id,
        p_full_name: input.fullName,
        p_reason: input.reason ?? null,
        p_apply_now: input.applyNow ?? true,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as { success?: boolean; full_name?: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payout-verification-queue'] });
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['holder-name-history'] });
    },
  });
}

/**
 * Admin rollback: put back the name a National ID adoption (or a manual
 * override) replaced. Admin-only (CFO / super admin) inside the database.
 */
export function useRevertHolderName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { auditId: string; reason?: string }) => {
      const { data, error } = await supabase.rpc('finops_revert_holder_name', {
        p_audit_id: input.auditId,
        p_reason: input.reason ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as { success?: boolean; full_name?: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payout-verification-queue'] });
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['holder-name-history'] });
    },
  });
}

export interface HolderNameChange {
  id: string;
  changed_at: string;
  changed_by: string | null;
  changed_by_name: string | null;
  old_name: string | null;
  new_name: string | null;
  source: string | null;
  reason: string | null;
  can_revert: boolean | null;
}

/**
 * Audit trail of every holder-name change made from the National ID (OCR
 * adoption, manual override, or the name applied at verification time).
 * Read-only and gated to Financial Ops / CFO / super admin in the database.
 */
export function useHolderNameHistory(userId?: string | null) {
  return useQuery({
    queryKey: ['holder-name-history', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('finops_holder_name_history', {
        p_user_id: userId as string,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as HolderNameChange[];
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
