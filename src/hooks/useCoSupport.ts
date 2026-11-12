import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getSignedUrl } from '@/lib/storageUtils';
import {
  coSupportFloatWatchState,
  normalizeCoSupportCode,
  type CoSupportInvite,
  type CoSupportPreview,
  type CoSupportStaffRow,
} from '@/lib/coSupport';

/**
 * Co-support data calls (two partners share one Rent Plan 50/50).
 * Every write is a SECURITY DEFINER function that checks the caller itself;
 * the browser never writes co-support or money rows directly.
 *
 * The co_support_* functions are not in the generated Supabase types until the
 * migration is applied and types.ts is regenerated, hence the untyped rpc.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpc = (fn: string, args?: Record<string, unknown>) => (supabase.rpc as any)(fn, args);

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export const coSupportKeys = {
  all: ['co-support'] as const,
  preview: (code: string) => ['co-support', 'preview', code] as const,
  mine: ['co-support', 'mine'] as const,
  staff: ['co-support', 'staff'] as const,
};

/** The invitation behind a link. Works before sign-in (public fields only). */
export function useCoSupportPreview(rawCode: string | null | undefined, signedInUserId?: string | null) {
  const code = normalizeCoSupportCode(rawCode);
  return useQuery({
    // the answer depends on who is asking (can_accept, own figures)
    queryKey: [...coSupportKeys.preview(code ?? ''), signedInUserId ?? 'anon'],
    enabled: !!code,
    staleTime: 15_000,
    queryFn: () => call<CoSupportPreview>('co_support_preview', { p_code: code }),
  });
}

/** Invitations I shared or accepted, newest first. */
export function useMyCoSupportInvites(enabled = true) {
  return useQuery({
    queryKey: coSupportKeys.mine,
    enabled,
    staleTime: 15_000,
    queryFn: () => call<CoSupportInvite[]>('co_support_my_invites'),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: coSupportKeys.all });
    // the float balance and its hold change with every co-support action
    qc.invalidateQueries({ queryKey: ['wallet'] });
    qc.invalidateQueries({ queryKey: ['wallet-view'] });
  };
}

/** Start sharing a Rent Plan: holds the plan and my half for 48 hours, returns the code. */
export function useCreateCoSupport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (rentRequestId: string) => call<CoSupportInvite>('co_support_create', { p_rent_request_id: rentRequestId }),
    onSuccess: invalidate,
  });
}

export type CoSupportAcceptResult = CoSupportInvite & {
  ok: boolean;
  status: CoSupportInvite['status'];
  reason?: string;
  message?: string;
  landlord_float_released?: boolean;
  idempotent_replay?: boolean;
};

/**
 * Take my half. ok=false with status 'plan_unavailable' means the plan went
 * elsewhere (or its rent changed) and nothing was taken: show `message`.
 */
export function useAcceptCoSupport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (code: string) => call<CoSupportAcceptResult>('co_support_accept', { p_code: normalizeCoSupportCode(code) ?? code }),
    onSuccess: invalidate,
  });
}

export function useDeclineCoSupport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (code: string) => call<CoSupportInvite>('co_support_decline', { p_code: normalizeCoSupportCode(code) ?? code }),
    onSuccess: invalidate,
  });
}

/** The sharer stops sharing; their half is free again at once. */
export function useCancelCoSupport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (inviteId: string) => call<CoSupportInvite>('co_support_cancel', { p_invite_id: inviteId }),
    onSuccess: invalidate,
  });
}

/**
 * Ask again for 48 more hours. newLink=false keeps the same link (same person,
 * clears a decline); newLink=true makes a new link and the old one stops working.
 */
export function useReinviteCoSupport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ inviteId, newLink }: { inviteId: string; newLink: boolean }) =>
      call<CoSupportInvite>('co_support_reinvite', { p_invite_id: inviteId, p_new_link: newLink }),
    onSuccess: invalidate,
  });
}

/**
 * Start sharing a verified empty house (same 48-hour hold as a Rent Plan).
 * When the partner accepts, both halves wait for Partner Ops, who approve or
 * reject them together; nothing is debited until then.
 */
export function useCreateCoSupportHouse() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (houseId: string) => call<CoSupportInvite>('co_support_create_house', { p_house_id: houseId }),
    onSuccess: invalidate,
  });
}

/** Partner Ops: shared Rent Plans and houses that have funding (or wait for approval). */
export function useCoSupportStaffList(enabled = true) {
  return useQuery({
    queryKey: coSupportKeys.staff,
    enabled,
    staleTime: 15_000,
    queryFn: () => call<CoSupportStaffRow[]>('co_support_staff_list', { p_limit: 100 }),
  });
}

export interface CoSupportStaffCancelResult {
  success: boolean;
  kind: 'rent_plan' | 'house';
  plan_released: boolean;
  refunds_due: Array<{ partner_id: string; partner_first_name: string | null; amount: number; commitment_id: string }> | null;
  note: string;
}

/** Partner Ops: cancel both halves of a funded shared Rent Plan or house (reason >= 10 characters). */
export function useCoSupportStaffCancel() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ inviteId, reason }: { inviteId: string; reason: string }) =>
      call<CoSupportStaffCancelResult>('co_support_staff_cancel', { p_invite_id: inviteId, p_reason: reason.trim() }),
    onSuccess: invalidate,
  });
}

/** The sharer pays the whole Rent Plan alone (operational float only). */
export function useFundCoSupportAlone() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (inviteId: string) => call<Record<string, unknown>>('co_support_fund_alone', { p_invite_id: inviteId }),
    onSuccess: invalidate,
  });
}

/**
 * The sharer's profile photo, signed for display (the avatars bucket is
 * private; any viewer may sign a URL in it). Null while loading, when there
 * is no photo, or when signing fails: show the placeholder silhouette then.
 */
export function useCoSupportLeadPhoto(storedUrl: string | null | undefined) {
  const url = String(storedUrl ?? '').trim();
  const q = useQuery({
    queryKey: ['co-support', 'lead-photo', url],
    enabled: !!url,
    staleTime: 50 * 60_000,
    retry: false,
    queryFn: async () => (await getSignedUrl(url)) || null,
  });
  return url ? (q.data ?? null) : null;
}

/**
 * After "I've paid" on the invitation's Add float sheet: re-reads the
 * invitation (the server's own float figures) and the deposit every few
 * seconds until the money has arrived, the deposit is rejected, or the
 * caller stops it. State comes from coSupportFloatWatchState.
 *
 * Pass the deposit from DepositFlow's onSubmitted; null when nothing is
 * waiting. Polling stops by itself once the state is 'arrived' or 'rejected'.
 */
export function useCoSupportFloatWatch(
  rawCode: string | null | undefined,
  signedInUserId: string | null | undefined,
  deposit: { id: string | null; submittedAt: number } | null,
) {
  const code = normalizeCoSupportCode(rawCode);
  const [now, setNow] = useState(() => Date.now());
  const active = !!deposit && !!code;

  // Polling stops once the money has arrived or the deposit was rejected.
  // Kept in a ref from the last render: each query's refetchInterval reads it,
  // so neither query refers to the other (react-query may call refetchInterval
  // while the hook is still running, before the second query exists).
  const doneRef = useRef(false);
  const poll = () => (doneRef.current ? false : 4_000);

  const preview = useQuery({
    // same key as useCoSupportPreview, so the page underneath updates too
    queryKey: [...coSupportKeys.preview(code ?? ''), signedInUserId ?? 'anon'],
    enabled: active,
    queryFn: () => call<CoSupportPreview>('co_support_preview', { p_code: code }),
    refetchInterval: poll,
  });
  const depositStatus = useQuery({
    queryKey: ['co-support', 'float-deposit', deposit?.id ?? ''],
    enabled: active && !!deposit?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deposit_requests')
        .select('status')
        .eq('id', deposit!.id as string)
        .maybeSingle();
      if (error) throw error;
      return (data?.status as string | undefined) ?? null;
    },
    refetchInterval: poll,
  });

  const state = coSupportFloatWatchState({
    submittedAt: deposit?.submittedAt ?? null,
    preview: preview.data,
    depositStatus: depositStatus.data,
    now,
  });
  const done = state === 'arrived' || state === 'rejected' || state === 'idle';
  doneRef.current = done;

  // tick so 'waiting' turns into 'slow' even when nothing else changes
  useEffect(() => {
    if (!active || done) return;
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [active, done]);

  return { state, preview: preview.data ?? null };
}
