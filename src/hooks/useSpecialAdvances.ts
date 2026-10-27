import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  SpecialAdvance, SpecialAdvanceList, SpecialAdvanceQuote, SpecialAdvanceReconciliation, SpecialAdvanceStatement,
  SpecialAdvanceStatus,
} from '@/lib/specialAdvances';

/**
 * Special Advances data access. Every call goes through the CFO-only `special_advance_*` SECURITY DEFINER functions
 * (enabled cfo role + staff MFA, server calculation, issuance flag, idempotency, append-only audit). This hook never
 * computes a figure and never writes a table, the ledger or a wallet itself.
 */

type RpcError = { message: string; code?: string; details?: string };
// The functions are not in the generated types until the migrations are applied, so they are called through this
// narrow untyped wrapper (method kept bound to the client).
const rpc = (fn: string, args?: Record<string, unknown>) =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError | null }>)
    .call(supabase, fn, args);

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw error;
  return data as T;
}

const KEY = 'special-advances';
// Server refusals (auth, validation, eligibility) are final; retrying them only delays the message.
const noRetryOnRefusal = (n: number, err: unknown) => {
  const code = (err as { code?: string } | null)?.code ?? '';
  return !['42501', '22023', '23505', '55000', 'P0002', '40001'].includes(code) && n < 2;
};

/** Server quote (schedule + eligibility + flag). `request` null = nothing to quote yet. Read-only. */
export function useSpecialAdvanceQuote(request: Record<string, unknown> | null) {
  return useQuery({
    queryKey: [KEY, 'quote', request],
    enabled: !!request,
    queryFn: () => call<SpecialAdvanceQuote>('special_advance_quote', { p_request: request }),
    staleTime: 30 * 1000,
    retry: noRetryOnRefusal,
  });
}

export function useSpecialAdvanceList(status: SpecialAdvanceStatus | null, enabled = true) {
  return useQuery({
    queryKey: [KEY, 'list', status],
    enabled,
    queryFn: () => call<SpecialAdvanceList>('special_advance_list', { p_status: status, p_limit: 100, p_offset: 0 }),
    staleTime: 30 * 1000,
    retry: noRetryOnRefusal,
  });
}

export function useSpecialAdvanceStatement(id: string | null) {
  return useQuery({
    queryKey: [KEY, 'statement', id],
    enabled: !!id,
    queryFn: () => call<SpecialAdvanceStatement>('special_advance_statement', { p_id: id }),
    staleTime: 15 * 1000,
    retry: noRetryOnRefusal,
  });
}

export function useSpecialAdvanceReconciliation(enabled = true) {
  return useQuery({
    queryKey: [KEY, 'reconciliation'],
    enabled,
    queryFn: () => call<SpecialAdvanceReconciliation>('special_advance_reconciliation'),
    staleTime: 60 * 1000,
    retry: noRetryOnRefusal,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [KEY] });
}

export function useCreateSpecialAdvance() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (request: Record<string, unknown>) => call<SpecialAdvance>('special_advance_create', { p_request: request }),
    onSuccess: invalidate,
  });
}

type Versioned = { id: string; updated_at: string };

export function useSpecialAdvanceDecision() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ action, advance, reason }: { action: 'approve' | 'reject' | 'cancel'; advance: Versioned; reason: string | null }) =>
      call<SpecialAdvance>(`special_advance_${action}`, { p_id: advance.id, p_expected_updated_at: advance.updated_at, p_reason: reason }),
    onSuccess: invalidate,
  });
}

export function useDisburseSpecialAdvance() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ advance, payout }: { advance: Versioned; payout: { payout_date: string; method: string; reference?: string | null } }) =>
      call<SpecialAdvanceStatement>('special_advance_disburse', { p_id: advance.id, p_expected_updated_at: advance.updated_at, p_payout: payout }),
    onSuccess: invalidate,
  });
}

export function useRecordSpecialAdvanceRepayment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ advanceId, repayment }: {
      advanceId: string;
      repayment: { amount: number; received_date: string; method: string; reference: string; note?: string | null; idempotency_key: string };
    }) => call<SpecialAdvanceStatement>('special_advance_record_repayment', { p_id: advanceId, p_repayment: repayment }),
    onSuccess: invalidate,
  });
}
