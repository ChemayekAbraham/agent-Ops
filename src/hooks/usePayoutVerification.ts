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
import {
  readNationalIdBackPhotoFromPath,
  type NationalIdBackDetails,
} from '@/lib/nationalIdOcr';


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
  double_kind: 'national_id' | 'phone' | 'face' | 'id_photo' | null;
  /** How many accounts share this National ID (1 = only this account). */
  id_account_count: number;
  /** This account's position among the ID's holders, oldest first (1 = first holder). */
  id_account_ordinal: number;
  /** How many payout numbers/accounts this person has saved in total. */
  payout_number_count: number;
  /** How many OTHER payout numbers are already verified for this person. */
  verified_payout_count: number;
  /** The already-verified payout numbers (oldest first), so a reviewer can see what came before. */
  verified_payout_numbers: {
    provider: string | null;
    destination_type: string | null;
    momo_number: string | null;
    bank_name: string | null;
    bank_account_number: string | null;
    account_name: string | null;
    decided_at: string | null;
  }[];
  double_of_user_id: string | null;
  double_of_name: string | null;
  /** True when this submission's National ID is one the person linked to from
   *  another account (the ID was already in the system; the holder approved).
   *  False means the ID is fresh — first time seen on the platform. */
  is_linked_id: boolean;
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

/** How often the queue re-checks the server on its own (tab must be visible). */
export const PAYOUT_VERIFICATION_POLL_MS = 30_000;

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

/** Everything the screen needs to explain a failed queue request. */
export interface PayoutQueueDiagnostics {
  endpoint: string;
  params: Record<string, unknown> | null;
  httpStatus: number | null;
  code: string | null;
  details: string | null;
  hint: string | null;
  rawMessage: string;
  signedInUserId: string | null;
  attemptedAt: string;
  durationMs: number;
}

/** Error carrying the request diagnostics alongside the plain-language message. */
export class PayoutQueueError extends Error {
  diagnostics: PayoutQueueDiagnostics;
  constructor(message: string, diagnostics: PayoutQueueDiagnostics) {
    super(message);
    this.name = 'PayoutQueueError';
    this.diagnostics = diagnostics;
  }
}

type RpcErrorLike = {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
  status?: number | null;
};

async function buildQueueError(
  endpoint: string,
  params: Record<string, unknown> | null,
  error: RpcErrorLike,
  startedAt: number,
): Promise<PayoutQueueError> {
  let signedInUserId: string | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    signedInUserId = data.user?.id ?? null;
  } catch {
    signedInUserId = null;
  }
  const raw = error.message ?? '';
  return new PayoutQueueError(payoutQueueErrorMessage(raw), {
    endpoint,
    params,
    httpStatus: typeof error.status === 'number' ? error.status : null,
    code: error.code ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
    rawMessage: raw || String(error),
    signedInUserId,
    attemptedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startedAt),
  });
}


/** Live counts for the badge and the filter chips. */
export function usePayoutVerificationCounts(enabled = true) {
  return useQuery({
    queryKey: ['payout-verification-counts'],
    enabled,
    staleTime: 15_000,
    retry: false,
    // Keep the chips live without a page reload; pause while the tab is hidden.
    refetchInterval: PAYOUT_VERIFICATION_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    queryFn: async (): Promise<PayoutVerificationCounts> => {
      const startedAt = performance.now();
      const { data, error } = await supabase.rpc('finops_payout_verification_counts');
      if (error) throw await buildQueueError('finops_payout_verification_counts', null, error, startedAt);
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
    staleTime: 15_000,
    // Self-refreshing queue: no page reload needed, and a failed load retries on its own.
    refetchInterval: PAYOUT_VERIFICATION_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    queryFn: async (): Promise<{ rows: PayoutDestinationRow[]; total: number }> => {
      const params = {
        p_status: status,
        p_search: search.trim() || null,
        p_sort: sort,
        p_limit: PAYOUT_VERIFICATION_PAGE_SIZE,
        p_offset: page * PAYOUT_VERIFICATION_PAGE_SIZE,
        p_date_from: dateFrom || null,
        p_date_to: dateTo || null,
        p_user_type: userType === 'all' ? null : userType,
      };
      const startedAt = performance.now();
      const { data, error } = await supabase.rpc('finops_payout_verification_queue', params);
      if (error) throw await buildQueueError('finops_payout_verification_queue', params, error, startedAt);
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
          is_linked_id: row.is_linked_id === true,
          id_account_count: Number(row.id_account_count ?? 1),
          id_account_ordinal: Number(row.id_account_ordinal ?? 1),
          payout_number_count: Number(row.payout_number_count ?? 1),
          verified_payout_count: Number(row.verified_payout_count ?? 0),
          verified_payout_numbers: Array.isArray(row.verified_payout_numbers)
            ? (row.verified_payout_numbers as PayoutDestinationRow['verified_payout_numbers'])
            : [],
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
      if (newStatus === 'verified' || newStatus === 'rejected') {
        // A decided case leaves every queue immediately — the operator sees the
        // next person slide in without waiting for the refetch. The invalidate
        // below brings the row back in the lists where it belongs (e.g. All,
        // Verified) with its fresh status.
        qc.setQueriesData<{ rows: PayoutDestinationRow[]; total: number }>(
          { queryKey: ['payout-verification-queue'] },
          (old) =>
            old
              ? {
                  ...old,
                  rows: old.rows.filter((r) => r.id !== data.id),
                  total: Math.max(0, old.total - (old.rows.some((r) => r.id === data.id) ? 1 : 0)),
                }
              : old,
        );
      } else if (newName || newStatus) {
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
  /** Timeline fields — when the account appeared, when the ID arrived and
   *  how the ID name compared with the name on this account. */
  first_seen_at: string | null;
  created_at: string | null;
  national_id: string | null;
  national_id_name: string | null;
  national_id_submitted_at: string | null;
  name_match_score: number | null;
  name_mismatch_tokens: unknown;
  /** Set when the person proved SIM ownership with the six-digit code. */
  ownership_code_confirmed_at: string | null;
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
          'id, destination_type, provider, momo_number, bank_name, bank_account_number, account_name, status, decision_reason, decided_at, first_seen_at, created_at, national_id, national_id_name, national_id_submitted_at, name_match_score, name_mismatch_tokens, ownership_code_confirmed_at',
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

/* ------------------------------------------------------------------ */
/* Stored National ID reading                                          */
/* ------------------------------------------------------------------ */

/**
 * What the ID reader actually read off the card at submission time, exactly as
 * it was stored — nothing is re-read or re-checked here. Financial Ops, CFO,
 * managers and super admins already hold SELECT on `national_id_readings`
 * ("Payout staff read ID readings"), so this is a plain read of existing rows.
 */
export interface StoredIdReading {
  /** 'valid' | 'incomplete' | … as recorded by the reader. */
  status: string | null;
  confidence: number | null;
  /** Recorded verdict of the live-face check on the selfie. */
  faceVerified: boolean | null;
  nin: string | null;
  cardNumber: string | null;
  sex: string | null;
  dateOfBirth: string | null;
  surname: string | null;
  givenName: string | null;
  /** Fields the reader could not read off the card. */
  missing: string[];
  readAt: string;
}

/** The most recent stored reading for one holder. */
export function useStoredIdReading(userId: string | null | undefined) {
  return useQuery({
    queryKey: ['stored-id-reading', userId],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<StoredIdReading | null> => {
      const { data, error } = await supabase
        .from('national_id_readings')
        .select('status, confidence, face_verified, ocr, confirmed, missing, created_at')
        .eq('user_id', userId as string)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;

      // `confirmed` is what the submitter confirmed on screen; `ocr` is the raw
      // read. Confirmed wins, the raw read fills any gap.
      const readValue = (key: string): string | null => {
        const pick = (src: unknown) => {
          const v = (src as Record<string, unknown> | null)?.[key];
          return typeof v === 'string' && v.trim() ? v.trim() : null;
        };
        return pick(data.confirmed) ?? pick(data.ocr);
      };

      return {
        status: data.status ?? null,
        confidence: data.confidence != null ? Number(data.confidence) : null,
        faceVerified: data.face_verified ?? null,
        nin: readValue('nin'),
        cardNumber: readValue('card_number'),
        sex: readValue('sex'),
        dateOfBirth: readValue('date_of_birth'),
        surname: readValue('surname'),
        givenName: readValue('given_name'),
        missing: Array.isArray(data.missing) ? (data.missing as string[]) : [],
        readAt: data.created_at,
      };
    },
  });
}

/**
 * The back of the stored National ID photo, re-read on demand so reviewers see
 * the same extracted details (card number, dates, residence, MRZ state) the
 * submitter was shown. The edge function permits finance staff to read the path
 * while keeping it blocked for ordinary users who do not own the photo.
 */
export interface StoredIdBackReading {
  details: { label: string; value: string }[];
  cardNumber: string | null;
  dateOfIssue: string | null;
  dateOfExpiry: string | null;
  mrzPresent: boolean;
  checksumsOk: boolean | null;
  readable: boolean;
  looksLikeFront: boolean;
  error: string | null;
}

export function useStoredIdBackReading(storagePath: string | null | undefined) {
  return useQuery({
    queryKey: ['stored-id-back-reading', storagePath],
    enabled: !!storagePath,
    staleTime: 120_000,
    queryFn: async (): Promise<StoredIdBackReading | null> => {
      if (!storagePath) return null;
      const res = await readNationalIdBackPhotoFromPath(storagePath);
      if ('error' in res) {
        return {
          details: [],
          cardNumber: null,
          dateOfIssue: null,
          dateOfExpiry: null,
          mrzPresent: false,
          checksumsOk: null,
          readable: false,
          looksLikeFront: false,
          error: res.error,
        };
      }
      const b = res as NationalIdBackDetails;
      const details: { label: string; value: string }[] = [];
      const push = (label: string, value: string | null | undefined) => {
        const v = String(value ?? '').trim();
        if (v) details.push({ label, value: v });
      };
      push('Card number', b.card_number ?? b.mrz?.document_number);
      push('NIN', b.mrz?.nin);
      push('Date of issue', b.date_of_issue);
      push('Date of expiry', b.date_of_expiry);
      push('Date of birth', b.mrz?.date_of_birth);
      push('Sex', b.mrz?.sex);
      push('Nationality', b.mrz?.nationality);
      push('Village', b.residence.village);
      push('Parish', b.residence.parish);
      push('Subcounty', b.residence.subcounty);
      push('County', b.residence.county);
      push('District', b.residence.district);
      for (const f of b.other_fields) push(f.label, f.value);
      return {
        details,
        cardNumber: b.card_number ?? b.mrz?.document_number ?? null,
        dateOfIssue: b.date_of_issue,
        dateOfExpiry: b.date_of_expiry,
        mrzPresent: b.mrz?.present ?? false,
        checksumsOk: b.mrz?.checksums_ok ?? null,
        readable: b.readable,
        looksLikeFront: b.side === 'front',
        error: null,
      };
    },
  });
}

/**
 * Did the payout number itself pass the SMS ownership code? Reviewers cannot
 * read `otp_verifications`, so this asks the server for a plain yes/no.
 */
export function usePayoutNumberOtpConfirmed(destinationId: string | null | undefined) {
  return useQuery({
    queryKey: ['payout-number-otp-confirmed', destinationId],
    enabled: !!destinationId,
    staleTime: 60_000,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc('finops_payout_number_ownership_confirmed', {
        p_destination_id: destinationId as string,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },
  });
}

/** Normalised comparison of two ID numbers (case and punctuation ignored). */
export function sameIdNumber(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const norm = (v: string | null | undefined) => (v ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase();
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return null; // nothing to compare
  return left === right;
}

/**
 * Show enough of an ID number to recognise it, never enough to reuse it:
 * first two and last two characters, the middle starred (`CM****HJ`).
 */
export function maskIdNumber(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  if (raw.length <= 4) return '*'.repeat(raw.length);
  return `${raw.slice(0, 2)}${'*'.repeat(Math.min(6, raw.length - 4))}${raw.slice(-2)}`;
}

/**
 * Every payout number one person has submitted, newest first — read-only, for
 * the Financial Ops drill-down that shows "this person has N requests".
 * Financial Ops, CFO and super admin can read all rows (RLS); a user reads
 * only their own.
 */
export interface PersonPayoutDestination {
  id: string;
  destination_type: string | null;
  provider: string | null;
  momo_number: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  status: PayoutVerificationStatus;
  decided_at: string | null;
  first_seen_at: string | null;
  created_at: string | null;
}

export function usePersonPayoutDestinations(userId?: string | null, enabled = true) {
  return useQuery({
    queryKey: ['person-payout-destinations', userId],
    enabled: !!userId && enabled,
    staleTime: 15_000,
    queryFn: async (): Promise<PersonPayoutDestination[]> => {
      const { data, error } = await supabase
        .from('payout_destination_verifications')
        .select(
          'id, destination_type, provider, momo_number, bank_name, bank_account_number, status, decided_at, first_seen_at, created_at',
        )
        .eq('user_id', userId as string)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as PersonPayoutDestination[];
    },
  });
}
