import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Bell, ShoppingBag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatUGX } from '@/lib/rentCalculations';

const db = supabase as any;
const SEEN_KEY = 'welile-cmo-orders-last-seen';

interface OrderRow {
  id: string;
  item_name: string;
  quantity: number;
  total_revenue: number;
  client_name: string | null;
  client_phone: string | null;
  selected_size: string | null;
  order_status: string | null;
  created_at: string;
}

/**
 * Header bell that surfaces "new merchandise order" notifications anywhere in
 * the CMO dashboard (not just the Merchandise tab). Unread state is tracked
 * against a locally stored last-seen timestamp — no DB writes (lean DB policy).
 */
export function MerchandiseOrderNotificationsBell({ onJump }: { onJump?: (tab: string) => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState<string>(() => {
    try {
      return localStorage.getItem(SEEN_KEY) || new Date(Date.now() - 7 * 86400000).toISOString();
    } catch {
      return new Date(Date.now() - 7 * 86400000).toISOString();
    }
  });
  const openRef = useRef(open);
  openRef.current = open;

  const { data: orders = [] } = useQuery<OrderRow[]>({
    queryKey: ['cmo-order-notifications'],
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_sales')
        .select('id,item_name,quantity,total_revenue,client_name,client_phone,selected_size,order_status,created_at')
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data || []) as OrderRow[];
    },
    staleTime: 60000,
  });

  const unread = useMemo(
    () => orders.filter((o) => new Date(o.created_at).getTime() > new Date(lastSeen).getTime()),
    [orders, lastSeen],
  );

  useEffect(() => {
    const channel = supabase
      .channel('cmo-order-notifications-bell')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'merchandise_sales' },
        (payload) => {
          const row = payload.new as OrderRow;
          queryClient.invalidateQueries({ queryKey: ['cmo-order-notifications'] });
          queryClient.invalidateQueries({ queryKey: ['merchandise-live-orders'] });
          queryClient.invalidateQueries({ queryKey: ['merchandise-sales'] });
          toast.success('New merchandise order', {
            description: `${row.client_name || 'Customer'} · ${row.item_name}${row.selected_size ? ` (${row.selected_size})` : ''} × ${row.quantity} · ${formatUGX(Number(row.total_revenue || 0))}`,
            duration: 10000,
            action: onJump
              ? { label: 'View', onClick: () => onJump('merchandise') }
              : undefined,
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, onJump]);

  const markSeen = () => {
    const now = new Date().toISOString();
    setLastSeen(now);
    try {
      localStorage.setItem(SEEN_KEY, now);
    } catch {
      /* ignore */
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) markSeen();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-9 w-9 text-primary-foreground hover:bg-white/10 hover:text-primary-foreground"
          aria-label="New merchandise orders"
        >
          <Bell className="h-4 w-4" />
          {unread.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {unread.length > 9 ? '9+' : unread.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <ShoppingBag className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">New customer orders</span>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {orders.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No orders yet.</p>
          ) : (
            orders.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onJump?.('merchandise');
                  setOpen(false);
                }}
                className="flex w-full flex-col gap-0.5 border-b border-border/40 px-3 py-2 text-left transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{o.client_name || 'Customer'}</span>
                  <span className="whitespace-nowrap text-xs font-semibold">
                    {formatUGX(Number(o.total_revenue || 0))}
                  </span>
                </div>
                <span className="truncate text-xs text-muted-foreground">
                  {o.item_name}
                  {o.selected_size ? ` (${o.selected_size})` : ''} × {o.quantity} ·{' '}
                  {o.order_status || 'submitted'}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {format(new Date(o.created_at), 'dd MMM yy HH:mm')}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}