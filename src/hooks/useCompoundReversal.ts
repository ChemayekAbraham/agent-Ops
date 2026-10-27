import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Compound requests: take a reinvested Return back out of a portfolio so it is paid as cash
 * through Nearing Payout. Partner Ops files; only the CFO approver decides. The database
 * enforces every rule and never credits the partner's wallet directly.
 */
type RpcFn = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
const rpc: RpcFn = (fn, args) =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => ReturnType<RpcFn>).call(supabase, fn, args);

export const COMPOUND_REQUEST_MIN_REASON = 20;

export interface CompoundCandidate {
  ledger_id: string; reinvested_at: string; amount: number; reference_id: string | null; description: string | null;
}
export interface CompoundRequestRow {
  id: string; portfolio_id: string; portfolio_code: string | null; partner_id: string; partner_name: string | null;
  amount: number; reinvested_at: string; reason: string; status: 'pending_cfo' | 'approved' | 'rejected';
  requested_by: string; requested_by_name: string | null; created_at: string; decided_by_name: string | null;
  decided_at: string | null; decision_note: string | null; cycle_date: string | null; override_id: string | null;
  current_principal: number;
}

export function useCompoundCandidates(portfolioId: string | null) {
  return useQuery({
    queryKey: ['compound-candidates', portfolioId],
    enabled: !!portfolioId,
    queryFn: async () => {
      const { data, error } = await rpc('compound_reversal_candidates', { p_portfolio_id: portfolioId });
      if (error) throw error;
      return (data || []) as CompoundCandidate[];
    },
  });
}

export function useCompoundRequests(status?: string) {
  return useQuery({
    queryKey: ['compound-requests', status ?? 'all'],
    queryFn: async () => {
      const { data, error } = await rpc('list_compound_reversal_requests', { p_status: status ?? null });
      if (error) throw error;
      return (data || []) as CompoundRequestRow[];
    },
  });
}

export function useFileCompoundRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { portfolioId: string; ledgerId: string; reason: string }) => {
      if (v.reason.trim().length < COMPOUND_REQUEST_MIN_REASON)
        throw new Error(`Give a reason of at least ${COMPOUND_REQUEST_MIN_REASON} characters`);
      const { data, error } = await rpc('request_compound_reversal', {
        p_portfolio_id: v.portfolioId, p_ledger_id: v.ledgerId, p_reason: v.reason.trim(),
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['compound-requests'] });
      qc.invalidateQueries({ queryKey: ['compound-candidates'] });
    },
  });
}

export function useDecideCompoundRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { requestId: string; approve: boolean; note: string }) => {
      if (v.note.trim().length < COMPOUND_REQUEST_MIN_REASON)
        throw new Error(`Give a note of at least ${COMPOUND_REQUEST_MIN_REASON} characters`);
      const { data, error } = await rpc('decide_compound_reversal', {
        p_request_id: v.requestId, p_approve: v.approve, p_note: v.note.trim(),
      });
      if (error) throw error;
      return data as { status: string; cycle_date?: string };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['compound-requests'] }),
  });
}
