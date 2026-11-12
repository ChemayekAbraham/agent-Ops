import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { isMissingServerFunction } from '@/lib/specialAdvances';
import type { MySpecialAdvances, WalletRepaymentReceipt } from '@/lib/specialAdvanceWallet';

/**
 * The signed-in borrower's Special Advances and Pay from Wallet (migration 20261117140000).
 * Both calls go to SECURITY DEFINER functions that read the caller from the session; this hook never computes a
 * balance and never writes a table, the ledger or a wallet itself.
 */

type RpcError = { message: string; code?: string; details?: string };
// Not in the generated types until the migration is applied: called through this narrow untyped wrapper.
const rpc = (fn: string, args?: Record<string, unknown>) =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError | null }>)
    .call(supabase, fn, args);

export const MY_SPECIAL_ADVANCES_KEY = ['my-special-advances'] as const;

/** null when the server does not offer it yet (migration not applied) or the user has no paid-out advance. */
export function useMySpecialAdvances(enabled = true) {
  return useQuery({
    queryKey: MY_SPECIAL_ADVANCES_KEY,
    enabled,
    queryFn: async (): Promise<MySpecialAdvances | null> => {
      const { data, error } = await rpc('special_advance_my_advances');
      if (error) {
        if (isMissingServerFunction(error)) return null;
        throw error;
      }
      return data as MySpecialAdvances;
    },
    staleTime: 30 * 1000,
    retry: (n, err) => !['42501', '22023', 'P0002'].includes((err as RpcError | null)?.code ?? '') && n < 2,
  });
}

export interface PayFromWalletInput {
  advanceId: string;
  amount: number;
  /** The outstanding balance the borrower saw and confirmed; the server refuses if it has changed. */
  expectedOutstanding: number;
  /** One key per payment intent, reused for a retry of the same payment (never charged twice). */
  idempotencyKey: string;
}

export function usePayFromWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PayFromWalletInput): Promise<WalletRepaymentReceipt> => {
      const { data, error } = await rpc('special_advance_pay_from_wallet', {
        p_id: input.advanceId,
        p_amount: input.amount,
        p_expected_outstanding: input.expectedOutstanding,
        p_idempotency_key: input.idempotencyKey,
      });
      if (error) throw error;
      return data as WalletRepaymentReceipt;
    },
    // a refusal can also mean the figures moved, so refresh either way
    onSettled: () => {
      qc.invalidateQueries({ queryKey: MY_SPECIAL_ADVANCES_KEY });
      qc.invalidateQueries({ queryKey: ['user-available-balance'] });
      qc.invalidateQueries({ queryKey: ['wallet-view'] });
      qc.invalidateQueries({ queryKey: ['agent-balances'] });
    },
  });
}
