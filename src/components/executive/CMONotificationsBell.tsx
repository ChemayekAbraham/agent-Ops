import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format, formatDistanceToNow } from 'date-fns';
import { Bell, Check, ShoppingBag, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import {
  useBudgetDepartmentNotifications,
  type DeptNotification,
} from '@/components/budget/useBudgetDepartmentNotifications';

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
 * Unified CMO notifications bell. Combines:
 *  - Department budget cycle notices (server-side read state)
 *  - New merchandise orders (local last-seen unread state)
 *
 * A single icon + dropdown keeps the CMO header uncluttered while still
 * surfacing both workstreams.
 */
export function CMONotificationsBell({ onJump }: { onJump?: (tab: string) => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  // --- Budget notices ---
  const {
    items: budgetItems,
    unread: budgetUnread,
    markRead,
    markAll,
  } = useBudgetDepartmentNotifications('cmo');

  // --- Merchandise orders ---
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
        .select(
          'id,item_name,quantity,total_revenue,client_name,client_phone,selected_size,order_status,created_at',
        )
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data || []) as OrderRow[];
    },
    staleTime: 60000,
  });

  const orderUnread = useMemo(
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
            description: `${row.client_name || 'Customer'} · ${row.item_name}${
              row.selected_size ? ` (${row.selected_size})` : ''
            } × ${row.quantity} · ${formatUGX(Number(row.total_revenue || 0))}`,
            duration: 10000,
            action: onJump ? { label: 'View', onClick: () => onJump('merchandise') } : undefined,
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, onJump]);

  const markOrdersSeen = () => {
    const now = new Date().toISOString();
    setLastSeen(now);
    try {
      localStorage.setItem(SEEN_KEY, now);
    } catch {
      /* ignore */
    }
  };

  const totalUnread = budgetUnread + orderUnread.length;

  const openBudgetItem = async (n: DeptNotification) => {
    if (!n.is_read) await markRead(n.id);
    navigate(n.link || '/budgets');
  };

  const openOrderItem = (o: OrderRow) => {
    onJump?.('merchandise');
  };

  const hasBudgetItems = budgetItems.length > 0;
  const hasOrders = orders.length > 0;

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) markOrdersSeen();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-9 w-9 text-primary-foreground hover:bg-white/10 hover:text-primary-foreground"
          aria-label="CMO notifications"
        >
          <Bell className="h-5 w-5" />
          {totalUnread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {totalUnread > 9 ? '9+' : totalUnread}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-80 p-0 rounded-2xl">
        <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-border">
          <h3 className="text-sm font-bold">Notifications</h3>
          {budgetUnread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-muted-foreground"
              onClick={markAll}
            >
              <Check className="h-3 w-3" />
              Mark all read
            </Button>
          )}
        </div>

        <div className="max-h-[420px] overflow-y-auto px-2 pb-2 space-y-3">
          {/* Budget notices */}
          <div>
            <div className="flex items-center gap-2 px-2 pt-2 pb-1">
              <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Department budgets
              </span>
            </div>
            {budgetItems.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                No budget notices for marketing.
              </p>
            ) : (
              <div className="space-y-1">
                {budgetItems.map((n) => (
                  <button
                    key={`budget-${n.id}`}
                    onClick={() => openBudgetItem(n)}
                    className={cn(
                      'w-full text-left px-3 py-2 rounded-xl transition-colors',
                      n.is_read
                        ? 'opacity-60 hover:bg-accent/30'
                        : 'bg-accent/40 hover:bg-accent/60',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-semibold leading-tight">{n.department_name}</p>
                      {!n.is_read && <span className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1" />}
                    </div>
                    <p className="text-[11px] font-medium mt-0.5">{n.cycle_title}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-3">
                      {n.message}
                    </p>
                    <p className="text-[10px] text-muted-foreground/70 mt-1">
                      {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })} · Open
                      Department Budgets
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Merchandise orders */}
          <div>
            <div className="flex items-center gap-2 px-2 pt-1 pb-1">
              <ShoppingBag className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                New customer orders
              </span>
            </div>
            {orders.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">No orders yet.</p>
            ) : (
              <div className="space-y-1">
                {orders.map((o) => {
                  const isUnread =
                    new Date(o.created_at).getTime() > new Date(lastSeen).getTime();
                  return (
                    <button
                      key={`order-${o.id}`}
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        openOrderItem(o);
                      }}
                      className={cn(
                        'flex w-full flex-col gap-0.5 rounded-xl px-3 py-2 text-left transition-colors',
                        isUnread ? 'bg-accent/40 hover:bg-accent/60' : 'hover:bg-muted/50',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {o.client_name || 'Customer'}
                        </span>
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
                  );
                })}
              </div>
            )}
          </div>

          {!hasBudgetItems && !hasOrders && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No notifications right now.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
