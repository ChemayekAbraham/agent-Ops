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

export function useStandingOrderAmount() {
  const qc = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async ({ order, newAmount, reason }: StandingOrderAmountEdit): Promise<AmountEditResult> => {
      if (!import.meta.env.DEV) throw new Error('Standing order amount changes are awaiting production approval.');
      // The not-yet-applied RPC is typed locally; never fall back to a table update
      // or the best-effort lifecycle audit helper. The server reads/locks fresh data.
      const rpc = supabase.rpc as unknown as (
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