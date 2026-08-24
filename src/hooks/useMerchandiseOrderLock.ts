import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const db = supabase as any;

/**
 * An order only blocks new orders while it is actively being repaid.
 * Pending, rejected, failed, or cancelled applications never lock the button —
 * the agent can remove them and place a fresh order.
 */
export function useMerchandiseOrderLock(userId?: string, itemName = 'Welile Smartphone') {
  const { data, isLoading } = useQuery({
    queryKey: ['merchandise-order-lock', userId, itemName],
    enabled: !!userId,
    queryFn: async () => {
      const { data: plans, error: plansError } = await db
        .from('merchandise_recovery_plans')
        .select('id, outstanding_balance, sale_id, merchandise_sales!inner(order_status)')
        .eq('customer_id', userId)
        .eq('item_name', itemName)
        .eq('status', 'active');
      if (plansError) throw plansError;

      const { data: sales, error: salesError } = await db
        .from('merchandise_sales')
        .select('id, amount_outstanding, order_status')
        .eq('customer_id', userId)
        .eq('item_name', itemName)
        .in('order_status', ['approved', 'processing']);
      if (salesError) throw salesError;

      const repayingStatuses = ['approved', 'processing', 'completed'];

      const activePlan = (plans.data ?? []).some((p: any) => {
        const outstanding = Number(p.outstanding_balance || 0);
        if (outstanding <= 0) return false;
        const saleStatus = p.merchandise_sales?.order_status ?? p.sale_status ?? null;
        // A plan only blocks when its sale is still in a repaying state.
        // If the sale is missing or has been rejected/failed/cancelled, treat as not repaying.
        return saleStatus == null || repayingStatuses.includes(saleStatus);
      });

      const owingSale = (sales.data ?? []).some(
        (s: any) => Number(s.amount_outstanding || 0) > 0
      );

      return { repaying: activePlan || owingSale };
    },
  });

  return { repaying: !!data?.repaying, isLoading };
}
