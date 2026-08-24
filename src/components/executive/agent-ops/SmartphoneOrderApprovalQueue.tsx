import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Smartphone, Check, X, Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';

const db = supabase as any;

interface SmartphoneOrderRow {
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

const STATUS_TONE: Record<string, string> = {
  pending_approval: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  submitted: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  approved: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  completed: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  rejected: 'bg-destructive/15 text-destructive border-destructive/30',
};

const isPending = (s: string) => s === 'pending_approval' || s === 'submitted';

/**
 * Executive queue for agent smartphone orders. Orders arrive as
 * Pending Approval with no wallet charge; approving one creates the
 * 33% wallet recovery plan, rejecting one requires a 10+ char reason.
 */
export function SmartphoneOrderApprovalQueue({ pendingOnly = false }: { pendingOnly?: boolean } = {}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [rejectTarget, setRejectTarget] = useState<SmartphoneOrderRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const { data: orders = [], isLoading } = useQuery<SmartphoneOrderRow[]>({
    queryKey: ['smartphone-order-queue'],
    queryFn: async () => {
      const { data, error } = await db.rpc('list_smartphone_orders', { p_status: null });
      if (error) throw error;
      return (data || []) as SmartphoneOrderRow[];
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['smartphone-order-queue'] });
    queryClient.invalidateQueries({ queryKey: ['agent-products'] });
  };

  const approve = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await db.rpc('approve_smartphone_order', { p_sale_id: id });
      if (error) throw error;
      return data;
    },
    onSuccess: (data: any) => {
      toast.success(`Order approved. ${formatUGX(Number(data?.recovery_amount || 0))} scheduled for wallet recovery.`);
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not approve order'),
  });

  const reject = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await db.rpc('reject_smartphone_order', { p_sale_id: id, p_reason: reason });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Order rejected. No wallet charge applied.');
      setRejectTarget(null);
      setRejectReason('');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not reject order'),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((o) =>
      [o.client_name, o.client_phone, o.brand, o.model_type]
        .some((v) => (v || '').toLowerCase().includes(q)),
    );
  }, [orders, search]);

  const pendingCount = useMemo(() => orders.filter((o) => isPending(o.order_status)).length, [orders]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Smartphone className="h-4 w-4 text-primary" />
          Smartphone orders awaiting approval
          <Badge variant="secondary">{pendingCount} pending</Badge>
        </CardTitle>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agent, phone, brand or model"
          className="mt-2 h-9"
        />
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading orders…
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">No smartphone orders yet.</p>
        ) : (
          filtered.map((o) => {
            const total = Number(o.total_amount || 0);
            const projection = Number(o.payment_projection || Math.round(total * 0.33));
            return (
              <div key={o.id} className="rounded-lg border p-3 space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{o.client_name || 'Agent'}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {o.client_phone || '—'} · {format(new Date(o.created_at), 'dd MMM yyyy HH:mm')}
                    </p>
                  </div>
                  <Badge variant="outline" className={STATUS_TONE[o.order_status] || ''}>
                    {o.order_status.replace(/_/g, ' ')}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="text-[10px] text-muted-foreground">Brand</p>
                    <p className="text-xs font-semibold">{o.brand || '—'}</p>
                  </div>
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="text-[10px] text-muted-foreground">Model</p>
                    <p className="text-xs font-semibold truncate">{o.model_type || '—'}</p>
                  </div>
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="text-[10px] text-muted-foreground">Phone amount</p>
                    <p className="text-xs font-semibold">{formatUGX(total)}</p>
                  </div>
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="text-[10px] text-muted-foreground">Projection (33%)</p>
                    <p className="text-xs font-semibold">{formatUGX(projection)}</p>
                  </div>
                </div>

                {o.rejection_reason && (
                  <p className="text-[11px] text-destructive">Rejected: {o.rejection_reason}</p>
                )}

                {isPending(o.order_status) && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => approve.mutate(o.id)}
                      disabled={approve.isPending}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { setRejectTarget(o); setRejectReason(''); }}
                    >
                      <X className="h-3.5 w-3.5 mr-1" /> Reject
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>

      <Dialog open={!!rejectTarget} onOpenChange={(o) => { if (!o) setRejectTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reject smartphone order</DialogTitle>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason (min 10 characters)"
            className="min-h-[80px]"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={reject.isPending || rejectReason.trim().length < 10 || !rejectTarget}
              onClick={() => rejectTarget && reject.mutate({ id: rejectTarget.id, reason: rejectReason.trim() })}
            >
              Reject order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
