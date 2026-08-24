import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const db = supabase as any;

/**
 * An order only blocks new orders while it is actively being repaid.
 * Pending applications never lock the button — the agent can cancel them
 * and place a fresh order.
 */
export function useMerchandiseOrderLock(userId?: string, itemName = 'Welile Smartphone') {
  const { data, isLoading } = useQuery({
    queryKey: ['merchandise-order-lock', userId, itemName],
    enabled: !!userId,
    queryFn: async () => {
      const [plans, sales] = await Promise.all([
        db
          .from('merchandise_recovery_plans')
          .select('id, outstanding_balance')
          .eq('customer_id', userId)
          .eq('item_name', itemName)
          .eq('status', 'active'),
        db
          .from('merchandise_sales')
          .select('id, amount_outstanding, order_status')
          .eq('customer_id', userId)
          .eq('item_name', itemName)
          .in('order_status', ['approved', 'processing']),
      ]);
      if (plans.error) throw plans.error;
      if (sales.error) throw sales.error;

      const activePlan = (plans.data ?? []).some((p: any) => Number(p.outstanding_balance || 0) > 0);
      const owingSale = (sales.data ?? []).some((s: any) => Number(s.amount_outstanding || 0) > 0);
      return { repaying: activePlan || owingSale };
    },
  });

  return { repaying: !!data?.repaying, isLoading };
}
