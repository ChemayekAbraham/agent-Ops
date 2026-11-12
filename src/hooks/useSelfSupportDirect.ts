import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  LandlordPayment,
  StaffLandlordPayment,
  StaffPaymentFilter,
  StaffResolveOutcome,
} from '@/lib/selfSupportDirect';

/**
 * Merchant-direct self-support data calls. Every call is a SECURITY DEFINER
 * function that checks the caller itself; the browser never writes these rows.
 * Not in the generated Supabase types until types.ts is regenerated, hence the
 * untyped rpc (same pattern as useCoSupport).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpc = (fn: string, args?: Record<string, unknown>) => (supabase.rpc as any)(fn, args);

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export const selfSupportDirectKeys = {
  all: ['self-support-direct'] as const,
  mine: ['self-support-direct', 'mine'] as const,
  staff: (filter: StaffPaymentFilter) => ['self-support-direct', 'staff', filter] as const,
};

/**
 * My landlord payments, as the partner (my halves) or as the plan's agent.
 * Refreshes every minute while one is still waiting for the merchant.
 */
export function useMyLandlordPayments(enabled = true) {
  return useQuery({
    queryKey: selfSupportDirectKeys.mine,
    enabled,
    staleTime: 30_000,
    queryFn: () => call<LandlordPayment[]>('self_support_my_landlord_payments', { p_limit: 50 }),
    refetchInterval: (q) => ((q.state.data ?? []).some((p) => p.status === 'queued') ? 60_000 : false),
  });
}

/** Financial Ops: payments that need a person ('attention'), all waiting ('queued'), or the latest ('all'). */
export function useStaffLandlordPayments(filter: StaffPaymentFilter = 'attention', enabled = true) {
  return useQuery({
    queryKey: selfSupportDirectKeys.staff(filter),
    enabled,
    staleTime: 15_000,
    queryFn: () => call<StaffLandlordPayment[]>('self_support_staff_landlord_payments', { p_filter: filter, p_limit: 200 }),
  });
}

export interface StaffResolveResult {
  ok: boolean;
  outcome?: StaffResolveOutcome;
  status?: string;
  noop?: boolean;
}

/**
 * Financial Ops settles a held or stuck payment:
 * 'refund' when the merchant did NOT pay (partner refunded, queue row closed),
 * 'paid' when the merchant DID pay (portfolio activates, everyone is told).
 * Use staffResolveProblem() first so the button explains why it is disabled.
 */
export function useResolveLandlordPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentId, outcome, reason }: { paymentId: string; outcome: StaffResolveOutcome; reason: string }) =>
      call<StaffResolveResult>('self_support_staff_resolve', {
        p_payment_id: paymentId,
        p_outcome: outcome,
        p_reason: reason.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: selfSupportDirectKeys.all });
      // a refund changes the partner's float; a paid one activates a portfolio
      qc.invalidateQueries({ queryKey: ['wallet'] });
      qc.invalidateQueries({ queryKey: ['wallet-view'] });
    },
  });
}
