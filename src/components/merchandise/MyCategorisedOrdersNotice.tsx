import { useQuery } from '@tanstack/react-query';
import { PackageCheck, Wallet } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';

/** Shows the agent what happens next for categorised orders that have no repayment plan yet. */
export function MyCategorisedOrdersNotice({ userId }: { userId?: string }) {
  const { data: rows = [] } = useQuery({
    queryKey: ['my-categorised-merch-orders', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('merchandise_sales')
        .select('id, item_name, total_revenue, order_status, fulfilment_type')
        .eq('customer_id', userId)
        .not('fulfilment_type', 'is', null)
        .in('order_status', ['pending_approval', 'submitted', 'ops_approved', 'coo_approved', 'awaiting_handover']);
      if (error) throw error;
      return data || [];
    },
  });
  if (!rows.length) return null;
  return (
    <div className="space-y-2">
      {rows.map((r: any) => {
        const company = r.fulfilment_type === 'company_issued';
        const ready = r.order_status === 'awaiting_handover';
        const Icon = company ? PackageCheck : Wallet;
        return (
          <div key={r.id} className="flex gap-3 rounded-xl border bg-card p-3 text-sm">
            <Icon className="h-4 w-4 mt-0.5 text-primary shrink-0" />
            <div>
              <div className="font-medium">{r.item_name} · {formatUGX(Number(r.total_revenue || 0))}</div>
              <p className="text-xs text-muted-foreground">
                {company
                  ? ready
                    ? 'Approved. Collect it from the company handler. Repayment starts once they confirm the handover.'
                    : 'Waiting for approval. Once approved, you collect it from the company handler.'
                  : 'Waiting for approval. Once approved, the money will be sent to your wallet and repayment starts.'}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
