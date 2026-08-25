import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
  const [detailsTarget, setDetailsTarget] = useState<SmartphoneOrderRow | null>(null);
  const [approveTarget, setApproveTarget] = useState<SmartphoneOrderRow | null>(null);
  const [officialAmount, setOfficialAmount] = useState('');

  const openApprove = (o: SmartphoneOrderRow) => {
    setApproveTarget(o);
    const existing = Number(o.total_amount || 0);
    setOfficialAmount(existing > 0 ? String(Math.round(existing)) : '');
  };

  const officialAmountNumber = Math.max(0, Math.round(Number(officialAmount || 0) || 0));
  const officialProjection = Math.round(officialAmountNumber * 0.33);


  const { data: wallet, isLoading: walletLoading } = useQuery({
    queryKey: ['smartphone-order-wallet', detailsTarget?.customer_id],
    enabled: !!detailsTarget?.customer_id,
    queryFn: async () => {
      const { data, error } = await db
        .from('wallets')
        .select('withdrawable_balance, float_balance, advance_balance')
        .eq('user_id', detailsTarget!.customer_id)
        .maybeSingle();
      if (error) throw error;
      return data as { withdrawable_balance: number; float_balance: number; advance_balance: number } | null;
    },
  });


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
    mutationFn: async ({ id, amount }: { id: string; amount: number }) => {
      const { data, error } = await db.rpc('approve_smartphone_order', {
        p_sale_id: id,
        p_total_amount: amount,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data: any) => {
      toast.success(
        `Order approved at ${formatUGX(Number(data?.total_amount || 0))}. ${formatUGX(Number(data?.payment_projection || 0))}/month (33%) recovery plan activated.`,
      );
      setApproveTarget(null);
      setOfficialAmount('');
      setDetailsTarget(null);
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
      setDetailsTarget(null);
      setRejectReason('');

      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not reject order'),
  });

  const scoped = useMemo(
    () => (pendingOnly ? orders.filter((o) => isPending(o.order_status)) : orders),
    [orders, pendingOnly],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((o) =>
      [o.client_name, o.client_phone, o.brand, o.model_type]
        .some((v) => (v || '').toLowerCase().includes(q)),
    );
  }, [scoped, search]);

  const pendingCount = useMemo(() => orders.filter((o) => isPending(o.order_status)).length, [orders]);

  const rowBusy = (id: string) =>
    (approve.isPending && approve.variables?.id === id) ||
    (reject.isPending && reject.variables?.id === id);


  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Smartphone className="h-4 w-4 text-primary" />
          {pendingOnly ? 'Pending applications' : 'Smartphone orders awaiting approval'}
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
          <p className="text-sm text-muted-foreground">
            {pendingOnly ? 'No applications awaiting approval.' : 'No smartphone orders yet.'}
          </p>
        ) : (
          filtered.map((o) => {
            const total = Number(o.total_amount || 0);
            const projection = Number(o.payment_projection || Math.round(total * 0.33));
            return (
              <div
                key={o.id}
                role="button"
                tabIndex={0}
                onClick={() => setDetailsTarget(o)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailsTarget(o); }
                }}
                className="rounded-lg border p-3 space-y-2 cursor-pointer transition-colors hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
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
                  <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                    <Button
                      size="sm"
                      onClick={() => openApprove(o)}
                      disabled={rowBusy(o.id)}
                    >
                      {approve.isPending && approve.variables?.id === o.id ? (
                        <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Approving…</>
                      ) : (
                        <><Check className="h-3.5 w-3.5 mr-1" /> Approve</>
                      )}
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { setRejectTarget(o); setRejectReason(''); }}
                      disabled={rowBusy(o.id)}
                    >
                      {reject.isPending && reject.variables?.id === o.id ? (
                        <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Rejecting…</>
                      ) : (
                        <><X className="h-3.5 w-3.5 mr-1" /> Reject</>
                      )}
                    </Button>
                  </div>
                )}

              </div>
            );
          })
        )}
      </CardContent>

      <Dialog open={!!detailsTarget} onOpenChange={(open) => { if (!open) setDetailsTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-primary" />
              Smartphone application
            </DialogTitle>
          </DialogHeader>
          {detailsTarget && (() => {
            const total = Number(detailsTarget.total_amount || 0);
            const projection = Number(detailsTarget.payment_projection || Math.round(total * 0.33));
            const rows: Array<[string, string]> = [
              ['Agent', detailsTarget.client_name || 'Agent'],
              ['Phone number', detailsTarget.client_phone || '—'],
              ['Submitted', format(new Date(detailsTarget.created_at), 'dd MMM yyyy HH:mm')],
              ['Brand', detailsTarget.brand || '—'],
              ['Model', detailsTarget.model_type || '—'],
              ['Phone amount', formatUGX(total)],
              ['Projection (33%)', formatUGX(projection)],
              ['Amount paid', formatUGX(Number(detailsTarget.amount_paid || 0))],
              ['Outstanding', formatUGX(Number(detailsTarget.amount_outstanding || 0))],
            ];
            return (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Status</span>
                  <Badge variant="outline" className={STATUS_TONE[detailsTarget.order_status] || ''}>
                    {detailsTarget.order_status.replace(/_/g, ' ')}
                  </Badge>
                </div>

                <div className="rounded-lg border divide-y">
                  {rows.map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-xs text-muted-foreground">{label}</span>
                      <span className="text-xs font-semibold text-right truncate">{value}</span>
                    </div>
                  ))}
                </div>

                <div className="rounded-lg border p-3 space-y-2">
                  <p className="text-xs font-semibold">Agent wallet (live)</p>
                  {!detailsTarget.customer_id ? (
                    <p className="text-[11px] text-muted-foreground">No linked agent account.</p>
                  ) : walletLoading ? (
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" /> Loading balances…
                    </p>
                  ) : (
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-md bg-muted/50 px-2 py-1.5">
                        <p className="text-[10px] text-muted-foreground">Withdrawable</p>
                        <p className="text-xs font-semibold">{formatUGX(Number(wallet?.withdrawable_balance || 0))}</p>
                      </div>
                      <div className="rounded-md bg-muted/50 px-2 py-1.5">
                        <p className="text-[10px] text-muted-foreground">Float</p>
                        <p className="text-xs font-semibold">{formatUGX(Number(wallet?.float_balance || 0))}</p>
                      </div>
                      <div className="rounded-md bg-muted/50 px-2 py-1.5">
                        <p className="text-[10px] text-muted-foreground">Advance</p>
                        <p className="text-xs font-semibold">{formatUGX(Number(wallet?.advance_balance || 0))}</p>
                      </div>
                    </div>
                  )}
                </div>

                {detailsTarget.rejection_reason && (
                  <p className="text-[11px] text-destructive">Rejected: {detailsTarget.rejection_reason}</p>
                )}

                {isPending(detailsTarget.order_status) && (
                  <DialogFooter className="gap-2 sm:gap-2">
                    <Button
                      variant="outline"
                      onClick={() => { setRejectTarget(detailsTarget); setRejectReason(''); }}
                    >
                      <X className="h-3.5 w-3.5 mr-1" /> Reject
                    </Button>
                    <Button
                      disabled={approve.isPending}
                      onClick={() => openApprove(detailsTarget)}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" /> Approve
                    </Button>

                  </DialogFooter>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!approveTarget}
        onOpenChange={(o) => { if (!o && !approve.isPending) { setApproveTarget(null); setOfficialAmount(''); } }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="h-4 w-4 text-primary" /> Approve smartphone order
            </DialogTitle>
          </DialogHeader>

          {approveTarget && (
            <div className="space-y-3">
              <div className="rounded-lg border divide-y">
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Agent</span>
                  <span className="text-xs font-semibold text-right truncate">
                    {approveTarget.client_name || 'Agent'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Device</span>
                  <span className="text-xs font-semibold text-right truncate">
                    {[approveTarget.brand, approveTarget.model_type].filter(Boolean).join(' · ') || '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Requested amount</span>
                  <span className="text-xs font-semibold">{formatUGX(Number(approveTarget.total_amount || 0))}</span>
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Official Phone Amount (UGX)</Label>
                <Input
                  type="number"
                  min={1000}
                  step={1000}
                  inputMode="numeric"
                  autoFocus
                  placeholder="e.g. 1200000"
                  value={officialAmount}
                  onChange={(e) => setOfficialAmount(e.target.value)}
                />
              </div>

              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-1">
                <p className="text-[11px] text-muted-foreground">Monthly Recovery Projection (33%)</p>
                <p className="text-lg font-bold text-primary">{formatUGX(officialProjection)}</p>
                <p className="text-[11px] text-muted-foreground">
                  Approving activates an official merchandise recovery plan of{' '}
                  {formatUGX(officialAmountNumber)} and the agent begins 33% wallet repayments.
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              disabled={approve.isPending}
              onClick={() => { setApproveTarget(null); setOfficialAmount(''); }}
            >
              Cancel
            </Button>
            <Button
              disabled={approve.isPending || officialAmountNumber < 1000 || !approveTarget}
              onClick={() => approveTarget && approve.mutate({ id: approveTarget.id, amount: officialAmountNumber })}
            >
              {approve.isPending ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Approving…</>
              ) : (
                <><Check className="h-3.5 w-3.5 mr-1" /> Confirm approval</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


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
            <Button variant="outline" disabled={reject.isPending} onClick={() => setRejectTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={reject.isPending || rejectReason.trim().length < 10 || !rejectTarget}
              onClick={() => rejectTarget && reject.mutate({ id: rejectTarget.id, reason: rejectReason.trim() })}
            >
              {reject.isPending ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Rejecting…</>
              ) : 'Reject order'}
            </Button>

          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
