/*
 * Author: SSENKAALI PIUS
 * Email: ssenkaali.pius@welileapp.com
 * Date: 2026-11-13
 * Website: welileapp.com
 *
 * Option 2 (the partner pays the landlord directly): data calls for the partner, Landlord Ops / the COO, and the
 * agent. Every call is one round trip to a SECURITY DEFINER function or edge function that checks the caller
 * itself; the browser never writes these rows, and never sees a "read" amount it could fake (the SMS is read by
 * the edge function direct-pay-proof). Lists are one query each; proof photos are signed in one batch per page.
 * Not in the generated Supabase types until types.ts is regenerated, hence the untyped rpc (same as useCoSupport).
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { uploadCashReceiptPhoto } from '@/lib/funderFundChoice';
import {
  DIRECT_PAY_PROOF_BUCKET,
  directPayQueueCursor,
  type DirectPayAgentItem,
  type DirectPayClaimResult,
  type DirectPayDecisionResult,
  type DirectPayOtpSendResult,
  type DirectPayQueuePage,
  type DirectPayQueueView,
  type DirectPayView,
} from '@/lib/directPay';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpc = (fn: string, args?: Record<string, unknown>) => (supabase.rpc as any)(fn, args);

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw error;
  return data as T;
}

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  // The edge functions answer refusals with a JSON body and a 4xx; supabase-js puts that body on error.context.
  if (error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (error as any)?.context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        return (await ctx.json()) as T;
      } catch {
        /* fall through */
      }
    }
    throw error;
  }
  return data as T;
}

export const directPayKeys = {
  all: ['direct-pay'] as const,
  mine: ['direct-pay', 'mine'] as const,
  queue: (view: DirectPayQueueView) => ['direct-pay', 'queue', view] as const,
  photos: (paths: string[]) => ['direct-pay', 'photos', [...paths].sort().join('|')] as const,
  agent: ['direct-pay', 'agent'] as const,
};

/** Partner pool lists that must drop or show a plan when a hold starts or ends. */
function invalidatePool(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: directPayKeys.mine });
  qc.invalidateQueries({ queryKey: ['psm-fundable-plans'] });
  qc.invalidateQueries({ queryKey: ['funder-new', 'ready-plans'] });
}

// ------------------------------------------------------------------ partner

/** My direct payments: live ones first. Refreshes every minute while one is held or with Landlord Ops. */
export function useMyDirectPayments(enabled = true) {
  return useQuery({
    queryKey: directPayKeys.mine,
    enabled,
    staleTime: 30_000,
    queryFn: () => call<DirectPayView[]>('direct_pay_my_payments'),
    refetchInterval: (q) => ((q.state.data ?? []).some((p) => p.status === 'held' || p.status === 'pending') ? 60_000 : false),
  });
}

/** "I'll pay the landlord": holds the plan for 48 hours and returns the landlord's verified number. */
export function useDirectPayClaim() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rentRequestId: string) => call<DirectPayClaimResult>('direct_pay_claim', { p_rent_request_id: rentRequestId }),
    onSuccess: () => invalidatePool(qc),
  });
}

/** Let go of a hold before uploading anything. */
export function useDirectPayRelease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) => call<DirectPayView>('direct_pay_release', { p_payment_id: paymentId }),
    onSuccess: () => invalidatePool(qc),
  });
}

/** Re-check a held payment (e.g. after topping up the float for the Cover fee). */
export function useDirectPayRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) => call<DirectPayView>('direct_pay_refresh', { p_payment_id: paymentId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: directPayKeys.mine }),
  });
}

export interface DirectPayProofInput {
  paymentId: string;
  rentRequestId: string;
  photo: File;
  tidTyped?: string | null;
  amountTyped?: number | null;
  provider?: 'mtn' | 'airtel' | null;
}

/**
 * Upload one SMS screenshot: the photo goes to storage (the existing partner upload helper, own folder only), then
 * ONE call to direct-pay-proof, which reads it on the server and returns the new status. The answer's code says
 * what to tell the partner (directPayMessage): e.g. amount_short with the amount still due.
 */
export function useDirectPayUploadProof() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DirectPayProofInput): Promise<DirectPayClaimResult> => {
      const photoPath = await uploadCashReceiptPhoto(input.rentRequestId, input.photo);
      if (!photoPath) return { ok: false, code: 'invalid_photo' };
      return invoke<DirectPayClaimResult>('direct-pay-proof', {
        payment_id: input.paymentId,
        photo_path: photoPath,
        tid_typed: input.tidTyped ?? null,
        amount_typed: input.amountTyped ?? null,
        provider: input.provider ?? null,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: directPayKeys.mine }),
  });
}

// ------------------------------------------------------------------ Landlord Ops and the COO

/** The queue, keyset-paged: 'pending' (flagged first, then oldest) or 'decided' (latest first). */
export function useDirectPayQueue(view: DirectPayQueueView = 'pending', enabled = true, pageSize = 30) {
  return useInfiniteQuery({
    queryKey: directPayKeys.queue(view),
    enabled,
    staleTime: 15_000,
    refetchInterval: view === 'pending' ? 60_000 : false,
    initialPageParam: null as ReturnType<typeof directPayQueueCursor>,
    queryFn: ({ pageParam }) =>
      call<DirectPayQueuePage>('direct_pay_ops_queue', {
        p_view: view,
        p_after_flagged: pageParam?.p_after_flagged ?? null,
        p_after_at: pageParam?.p_after_at ?? null,
        p_after_id: pageParam?.p_after_id ?? null,
        p_limit: pageSize,
      }),
    getNextPageParam: (last) =>
      last.rows.length < pageSize ? undefined : directPayQueueCursor(view, last.rows[last.rows.length - 1]),
  });
}

/** Signed links for every proof photo on the page, in ONE call (no request per photo). Links last 10 minutes. */
export function useDirectPayProofPhotos(paths: string[], enabled = true) {
  return useQuery({
    queryKey: directPayKeys.photos(paths),
    enabled: enabled && paths.length > 0,
    staleTime: 8 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from(DIRECT_PAY_PROOF_BUCKET).createSignedUrls(paths, 600);
      if (error) throw error;
      return Object.fromEntries((data ?? []).filter((d) => d.path && d.signedUrl).map((d) => [d.path as string, d.signedUrl]));
    },
  });
}

/** Send OTP: the code goes by SMS to the landlord's phone on file; the officer only gets "sent to ***456". */
export function useDirectPaySendOtp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) => invoke<DirectPayOtpSendResult>('direct-pay-landlord-otp', { payment_id: paymentId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: directPayKeys.queue('pending') }),
  });
}

export interface DirectPayApproveInput {
  paymentId: string;
  otp: string;
  callNote: string;
  flagReason?: string | null;
}

export function useDirectPayApprove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (i: DirectPayApproveInput) =>
      call<DirectPayDecisionResult>('direct_pay_approve', {
        p_payment_id: i.paymentId,
        p_otp: i.otp.trim(),
        p_call_note: i.callNote.trim(),
        p_flag_reason: i.flagReason?.trim() || null,
      }),
    // A wrong code also changes the row (tries left), so refresh either way.
    onSettled: () => qc.invalidateQueries({ queryKey: directPayKeys.all }),
  });
}

export function useDirectPayReject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) =>
      call<DirectPayDecisionResult>('direct_pay_reject', { p_payment_id: paymentId, p_reason: reason.trim() }),
    onSettled: () => qc.invalidateQueries({ queryKey: directPayKeys.all }),
  });
}

// ------------------------------------------------------------------ agent

/** The agent's Rent Plans that partners paid directly, and which still need the landlord's signed receipt. */
export function useDirectPayAgentItems(enabled = true) {
  return useQuery({
    queryKey: directPayKeys.agent,
    enabled,
    staleTime: 60_000,
    queryFn: () => call<DirectPayAgentItem[]>('direct_pay_agent_items', { p_limit: 50 }),
  });
}

export function useDirectPayRecordLandlordReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentId, receiptNumber, photoPath }: { paymentId: string; receiptNumber: string; photoPath?: string | null }) =>
      call<{ ok: boolean; code?: string; landlord_receipt_number?: string }>('direct_pay_agent_record_receipt', {
        p_payment_id: paymentId,
        p_receipt_number: receiptNumber.trim(),
        p_photo_path: photoPath ?? null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: directPayKeys.agent }),
  });
}

/** Re-exported so screens import from one place. */
export type { DirectPayView, DirectPayClaimResult };
