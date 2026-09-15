/**
 * Controlled withdrawal-number change.
 *
 * A locked withdrawal number can only move when Financial Ops approves a
 * request. The person proves they hold the new SIM with a code first; the
 * request then waits for a decision, and the decision is what updates the
 * number. Nothing here changes a number on its own.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface NumberChangeRequest {
  id: string;
  user_id: string;
  full_name: string | null;
  phone: string | null;
  national_id: string | null;
  current_number: string | null;
  requested_number: string;
  requested_name: string;
  requested_provider: string | null;
  request_reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  ownership_code_confirmed_at: string | null;
  decision_reason: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  created_at: string;
}

/** What the person must fix before they can withdraw, in order. */
export interface WithdrawalBlock {
  blocked: boolean;
  code: string;
  headline?: string;
  status?: string;
  reasons: string[];
}

export function useWithdrawalBlockReasons(userId?: string) {
  const { user } = useAuth();
  const id = userId ?? user?.id;
  return useQuery({
    queryKey: ['withdrawal-block-reasons', id],
    enabled: !!id,
    staleTime: 30_000,
    queryFn: async (): Promise<WithdrawalBlock> => {
      const { data, error } = await supabase.rpc('payout_withdrawal_block_reasons', {
        p_user_id: id!,
      });
      if (error) throw error;
      const r = (data ?? {}) as Partial<WithdrawalBlock>;
      return {
        blocked: r.blocked === true,
        code: r.code ?? 'ok',
        headline: r.headline,
        status: r.status,
        reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [],
      };
    },
  });
}

/** The person's own latest change request, so the screen can show its state. */
export function useMyNumberChangeRequest() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-number-change-request', user?.id],
    enabled: !!user?.id,
    staleTime: 20_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payout_number_change_requests')
        .select('id, requested_number, requested_name, status, decision_reason, created_at, decided_at')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  });
}

export function useRequestNumberChange() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (v: { number: string; name: string; provider: string; reason: string }) => {
      const { data, error } = await supabase.rpc('request_payout_number_change', {
        p_number: v.number,
        p_name: v.name,
        p_provider: v.provider,
        p_reason: v.reason,
      });
      if (error) throw error;
      const res = (data ?? {}) as { success?: boolean; message?: string; code?: string };
      if (res.success !== true) throw new Error(res.message || 'Could not send the request.');
      return res;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-number-change-request', user?.id] });
    },
  });
}

export function useCancelNumberChange() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('cancel_payout_number_change', { p_request_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-number-change-request', user?.id] });
    },
  });
}

/* ------------------------------------------------------------ Financial Ops */

export function useNumberChangeQueue(status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending') {
  return useQuery({
    queryKey: ['finops-number-change-queue', status],
    staleTime: 15_000,
    queryFn: async (): Promise<NumberChangeRequest[]> => {
      const { data, error } = await supabase.rpc('finops_payout_number_change_requests', {
        p_status: status,
      });
      if (error) throw error;
      return (data ?? []) as NumberChangeRequest[];
    },
  });
}

export function useDecideNumberChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; decision: 'approved' | 'rejected'; reason: string }) => {
      const { data, error } = await supabase.rpc('finops_decide_payout_number_change', {
        p_request_id: v.id,
        p_decision: v.decision,
        p_reason: v.reason,
      });
      if (error) throw error;
      /* Tell the person what was decided. Best-effort: the decision is already
         recorded, so a failed SMS must never look like a failed decision. The
         function re-reads the outcome from the database itself. */
      void supabase.functions
        .invoke('notify-payout-number-change', { body: { requestId: v.id } })
        .catch(() => undefined);
      return data as { success?: boolean; status?: string };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['finops-number-change-queue'] });
      void qc.invalidateQueries({ queryKey: ['my-number-change-request'] });
      void qc.invalidateQueries({ queryKey: ['withdrawal-block-reasons'] });
      void qc.invalidateQueries({ queryKey: ['identity-binding'] });
    },
  });
}
