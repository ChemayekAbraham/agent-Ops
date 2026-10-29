import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { StandingOrderRow } from './useStandingOrders';

export interface StandingOrderAmountEdit {
  order: Pick<StandingOrderRow, 'id' | 'amount' | 'updated_at'>;
  newAmount: number;
  reason: string;
}

interface AmountEditResult {
  order: { id: string; amount: number; updated_at: string };
  audit_id: string;
  previous_amount: number;
}

// Saving is activated for production (approved by the CFO): the server RPC is
// the sole authority — it checks the CFO/super-admin role, staff MFA, locks the
// row, and writes the audit atomically. Never fall back to a table update or
// the best-effort lifecycle audit helper.
export function useStandingOrderAmount() {
  const qc = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async ({ order, newAmount, reason }: StandingOrderAmountEdit): Promise<AmountEditResult> => {
      // The RPC is typed locally; the server reads/locks fresh data.
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        name: 'standing_order_set_amount',
        args: { p_order_id: string; p_expected_amount: number; p_expected_updated_at: string; p_new_amount: number; p_reason: string },
      ) => Promise<{ data: AmountEditResult | null; error: { message: string } | null }>;
      const { data, error } = await rpc('standing_order_set_amount', {
        p_order_id: order.id,
        p_expected_amount: order.amount,
        p_expected_updated_at: order.updated_at,
        p_new_amount: newAmount,
        p_reason: reason.trim(),
      });
      if (error) throw new Error(error.message);
      if (!data?.audit_id || data.order?.id !== order.id || data.order.amount !== newAmount) {
        throw new Error('The revised amount was not confirmed. Refresh before trying again.');
      }
      return data;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['cfo-standing-orders'] }),
  });
}