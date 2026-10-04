import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Bell, BellOff, Radio, ShoppingBag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';

const db = supabase as any;

interface LiveOrder {
  id: string;
  item_name: string;
  quantity: number;
  total_revenue: number;
  client_name: string | null;
  client_phone: string | null;
  payment_plan: string | null;
  selected_size: string | null;
  order_status: string | null;
  created_at: string;
}

const statusTone: Record<string, string> = {
  submitted: 'bg-primary/15 text-primary',
  processing: 'bg-amber-500/15 text-amber-600',
  completed: 'bg-emerald-500/15 text-emerald-600',
  rejected: 'bg-red-500/15 text-red-600',
  failed: 'bg-red-500/15 text-red-600',
};

/**
 * Live feed of merchandise orders placed by users, with a realtime pop-up
 * notification whenever a new order lands. Visible to CMO / manager /
 * super_admin only (enforced by RLS on merchandise_sales).
 */
export function MerchandiseLiveOrders() {
  const queryClient = useQueryClient();
  const [notify, setNotify] = useState(true);
  const [connected, setConnected] = useState(false);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const { data: orders = [] } = useQuery<LiveOrder[]>({
    queryKey: ['merchandise-live-orders'],
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_sales')
        .select('id,item_name,quantity,total_revenue,client_name,client_phone,payment_plan,selected_size,order_status,created_at')
        .order('created_at', { ascending: false })
        .limit(25);
      if (error) throw error;
      return data || [];
    },
    staleTime: 30000,
  });

  useEffect(() => {
    const channel = supabase
      .channel('cmo-merchandise-orders')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'merchandise_sales' },
        (payload) => {
          const row = payload.new as LiveOrder;
          queryClient.invalidateQueries({ queryKey: ['merchandise-live-orders'] });
          queryClient.invalidateQueries({ queryKey: ['merchandise-sales'] });
          if (!notifyRef.current) return;
          toast.success('New merchandise order', {
            description: `${row.client_name || 'Customer'} · ${row.item_name}${row.selected_size ? ` (${row.selected_size})` : ''} × ${row.quantity} · ${formatUGX(Number(row.total_revenue || 0))}`,
            duration: 10000,
          });
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'merchandise_sales' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['merchandise-live-orders'] });
        },
      )
      .subscribe((status) => setConnected(status === 'SUBSCRIBED'));

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return (
    <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShoppingBag className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Live Customer Orders</h3>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${connected ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-muted-foreground'}`}>
            <Radio className="h-3 w-3" /> {connected ? 'Live' : 'Connecting'}
          </span>
        </div>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => setNotify((v) => !v)}>
          {notify ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
          {notify ? 'Pop-ups on' : 'Pop-ups off'}
        </Button>
      </div>

      {orders.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">No orders placed yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3">Placed at</th>
                <th className="py-2 px-3">Customer</th>
                <th className="py-2 px-3">Item</th>
                <th className="py-2 px-3 text-right">Qty</th>
                <th className="py-2 px-3 text-right">Amount</th>
                <th className="py-2 px-3">Plan</th>
                <th className="py-2 pl-3">Order</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-border/40">
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <div className="font-medium">{format(new Date(o.created_at), 'dd MMM yy')}</div>
                    <div className="text-[11px] text-muted-foreground">{format(new Date(o.created_at), 'HH:mm')}</div>
                  </td>
                  <td className="py-2 px-3">
                    <div className="font-medium">{o.client_name || 'Customer'}</div>
                    <div className="text-[11px] text-muted-foreground">{o.client_phone || '—'}</div>
                  </td>
                  <td className="py-2 px-3">
                    {o.item_name}
                    {o.selected_size ? <span className="text-muted-foreground"> ({o.selected_size})</span> : null}
                  </td>
                  <td className="py-2 px-3 text-right">{o.quantity}</td>
                  <td className="py-2 px-3 text-right font-semibold">{formatUGX(Number(o.total_revenue || 0))}</td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {o.payment_plan === 'installment' ? 'Installments' : 'Paid in full'}
                  </td>
                  <td className="py-2 pl-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${statusTone[o.order_status || 'submitted'] || 'bg-muted text-muted-foreground'}`}>
                      {o.order_status || 'submitted'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
