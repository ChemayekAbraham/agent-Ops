import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { RefreshCw, Smartphone, Check, X } from 'lucide-react';

interface SmartphoneOrder {
  id: string;
  customer_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  brand: string | null;
  model_type: string | null;
  total_amount: number | null;
  payment_projection: number | null;
  amount_outstanding: number | null;
  amount_paid: number | null;
  order_status: string;
  rejection_reason: string | null;
  created_at: string;
}

const statusTone: Record<string, string> = {
  pending_approval: 'bg-amber-500/15 text-amber-600',
  submitted: 'bg-amber-500/15 text-amber-600',
  approved: 'bg-emerald-500/15 text-emerald-600',
  rejected: 'bg-red-500/15 text-red-600',
};

const statusLabel: Record<string, string> = {
  pending_approval: 'Pending approval',
  submitted: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

/**
 * Agent Smart Phones — order queue. Agents submit orders with no upfront
 * wallet check; wallet recovery only starts once an order is approved here.
 */
export function SmartphoneOrderApprovals() {
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState<SmartphoneOrder | null>(null);
  const [reason, setReason] = useState('');

  const { data: orders = [], isLoading, isFetching, refetch } = useQuery<SmartphoneOrder[]>({
    queryKey: ['smartphone-orders'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_smartphone_orders' as any, { p_status: null });
      if (error) throw error;
      return (data ?? []) as SmartphoneOrder[];
    },
    staleTime: 30_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['smartphone-orders'] });
    queryClient.invalidateQueries({ queryKey: ['agent-products-overview'], exact: false });
  };

  const approve = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('approve_smartphone_order' as any, { p_sale_id: id, p_note: null });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Order approved — wallet recovery started');
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message || 'Could not approve order'),
  });

  const reject = useMutation({
    mutationFn: async ({ id, why }: { id: string; why: string }) => {
      const { error } = await supabase.rpc('reject_smartphone_order' as any, { p_sale_id: id, p_reason: why });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Order rejected');
      setRejecting(null);
      setReason('');
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message || 'Could not reject order'),
  });

  const pending = orders.filter((o) => ['pending_approval', 'submitted'].includes(o.order_status));

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Smartphone className="h-4 w-4 text-primary" />
            Smartphone orders ({orders.length})
            {pending.length > 0 && (
              <Badge className="bg-amber-500/15 text-amber-600">{pending.length} pending</Badge>
            )}
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="gap-1.5">
            <RefreshCw className={isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : orders.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No smartphone orders submitted by agents yet.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {orders.map((o) => {
                const isPending = ['pending_approval', 'submitted'].includes(o.order_status);
                return (
                  <div key={o.id} className="flex flex-wrap items-start gap-3 p-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold">{o.client_name || 'Agent'}</p>
                        <span className="text-xs text-muted-foreground">{o.client_phone || '—'}</span>
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${statusTone[o.order_status] || 'bg-muted text-muted-foreground'}`}>
                          {statusLabel[o.order_status] || o.order_status}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {[o.brand, o.model_type].filter(Boolean).join(' · ') || 'Welile Smartphone'}
                        {' · '}
                        {format(new Date(o.created_at), 'dd MMM yyyy HH:mm')}
                      </p>
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                        <span>Total: <span className="font-semibold tabular-nums">{formatUGX(Number(o.total_amount || 0))}</span></span>
                        <span className="text-muted-foreground">
                          33% recovery: <span className="font-semibold tabular-nums">{formatUGX(Number(o.payment_projection || 0))}</span>
                        </span>
                        {o.order_status === 'approved' && (
                          <span className="text-destructive">
                            Outstanding: <span className="font-semibold tabular-nums">{formatUGX(Number(o.amount_outstanding || 0))}</span>
                          </span>
                        )}
                      </div>
                      {o.rejection_reason && (
                        <p className="text-[11px] text-destructive">Reason: {o.rejection_reason}</p>
                      )}
                    </div>
                    {isPending && (
                      <div className="flex shrink-0 gap-2">
                        <Button
                          size="sm"
                          className="gap-1.5"
                          onClick={() => approve.mutate(o.id)}
                          disabled={approve.isPending}
                        >
                          <Check className="h-3.5 w-3.5" /> Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          onClick={() => { setRejecting(o); setReason(''); }}
                        >
                          <X className="h-3.5 w-3.5" /> Reject
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!rejecting} onOpenChange={(o) => { if (!o) setRejecting(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reject smartphone order</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {rejecting?.client_name} · {[rejecting?.brand, rejecting?.model_type].filter(Boolean).join(' ')}
            </p>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason for rejection (minimum 10 characters)"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={reason.trim().length < 10 || reject.isPending}
              onClick={() => rejecting && reject.mutate({ id: rejecting.id, why: reason.trim() })}
            >
              {reject.isPending ? 'Rejecting…' : 'Reject order'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
