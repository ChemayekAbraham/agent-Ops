import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
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
