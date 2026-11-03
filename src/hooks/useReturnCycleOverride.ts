import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * CFO override for an exceptional extra Partner Return in a cycle that already has one
 * (migration 20261024140000_return_cycle_guard).
 *
 * AUTHORISING PAYS NOTHING. It records a single-use permission for one portfolio and one cycle month, valid for
 * 24 hours, naming the ONE staff member who may use it (never the authoriser), with the reason, in audit_logs.
 * That person then requests the extra Return quoting the override id (metadata.override_id, or p_override_id on a
 * compound/split); it goes through the normal approval chain. An override cannot be used at approval.
 * Only the CFO approver may authorise or revoke; the database enforces that and every other rule.
 */

type RpcFn = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
// Keep the method bound to the client (see usePayables).
const rpc: RpcFn = (fn, args) =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>)
    .call(supabase, fn, args);

export const RETURN_OVERRIDE_MIN_REASON = 20;

export interface AuthoriseReturnOverrideInput {
  portfolioId: string;
  /** Any date inside the cycle month (YYYY-MM-DD). */
  cycleDate: string;
  /** The staff member who will request the extra Return. Must not be the authorising CFO. */
  requesterId: string;
  reason: string;
}

export function useAuthoriseReturnCycleOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ portfolioId, cycleDate, requesterId, reason }: AuthoriseReturnOverrideInput): Promise<string> => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cycleDate)) throw new Error('Choose the cycle date');
      if (!requesterId) throw new Error('Choose who will request the Return');
      if (reason.trim().length < RETURN_OVERRIDE_MIN_REASON) {
        throw new Error(`Give a reason of at least ${RETURN_OVERRIDE_MIN_REASON} characters`);
      }
      const { data, error } = await rpc('authorise_return_cycle_override', {
        p_portfolio_id: portfolioId, p_cycle_date: cycleDate, p_requester: requesterId, p_reason: reason.trim(),
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['return-cycle-overrides'] }),
  });
}

export function useRevokeReturnCycleOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ overrideId, reason }: { overrideId: string; reason: string }): Promise<void> => {
      const { error } = await rpc('revoke_return_cycle_override', { p_override_id: overrideId, p_reason: reason.trim() });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['return-cycle-overrides'] }),
  });
}
