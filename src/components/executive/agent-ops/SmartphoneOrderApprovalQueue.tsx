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
  ops_approved_at?: string | null;
  coo_approved_at?: string | null;
  cfo_disbursed_at?: string | null;
  disbursed_amount?: number | null;
  access_daily_amount?: number | null;
  access_repayment_days?: number | null;
  advance_period_months?: number | null;
  advance_markup_pct?: number | null;
  total_repayable?: number | null;
  repayment_starts_on?: string | null;
  applicant_rank?: number | null;
  rank_cap?: number | null;
  supplier_id?: string | null;
  supplier_name?: string | null;
  overdue_surcharge_total?: number | null;
}

const STATUS_TONE: Record<string, string> = {
  pending_approval: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  submitted: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  ops_approved: 'bg-violet-500/15 text-violet-600 border-violet-500/30',
  coo_approved: 'bg-sky-500/15 text-sky-600 border-sky-500/30',
  approved: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  completed: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  rejected: 'bg-destructive/15 text-destructive border-destructive/30',
};

const STATUS_LABEL: Record<string, string> = {
  pending_approval: 'Awaiting Agent Ops',
  submitted: 'Awaiting Agent Ops',
  ops_approved: 'Awaiting COO',
  coo_approved: 'Awaiting CFO supplier payment',
  approved: 'Supplier paid & active',
};

const statusLabel = (s: string) => STATUS_LABEL[s] || s.replace(/_/g, ' ');

type Stage = 'ops' | 'coo' | 'cfo';

/** Stage 1 — Agent Ops verifies eligibility. */
const isPendingOps = (s: string) => s === 'pending_approval' || s === 'submitted';
/** Stage 2 — COO decision. */
const isAwaitingCoo = (s: string) => s === 'ops_approved';
/** Stage 3 — CFO pays the supplier. */
const isAwaitingCfo = (s: string) => s === 'coo_approved';
const isOpen = (s: string) => isPendingOps(s) || isAwaitingCoo(s) || isAwaitingCfo(s);

const stageOf = (s: string): Stage => (isAwaitingCfo(s) ? 'cfo' : isAwaitingCoo(s) ? 'coo' : 'ops');

const STAGE_RPC: Record<Stage, string> = {
  ops: 'agent_ops_approve_smartphone_order',
  coo: 'coo_approve_smartphone_order',
  cfo: 'cfo_disburse_smartphone_order',
};

const STAGE_CTA: Record<Stage, string> = {
  ops: 'Verify & send to COO',
  coo: 'Approve & send to CFO',
  cfo: 'Pay supplier & activate',
};

/**
 * Executive queue for agent smartphone advance applications — Agent Ops verifies
 * eligibility, the COO approves, and the CFO pays the registered supplier
 * directly. Amounts come from the catalogue and the agent's chosen period, so no
 * reviewer edits figures here. Rejecting needs a 10+ character reason.
 */
export function SmartphoneOrderApprovalQueue({ pendingOnly = false }: { pendingOnly?: boolean } = {}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [rejectTarget, setRejectTarget] = useState<SmartphoneOrderRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [detailsTarget, setDetailsTarget] = useState<SmartphoneOrderRow | null>(null);
  const [approveTarget, setApproveTarget] = useState<SmartphoneOrderRow | null>(null);
  const [note, setNote] = useState('');

  const approveStage: Stage = approveTarget ? stageOf(approveTarget.order_status) : 'ops';

  const openApprove = (o: SmartphoneOrderRow) => {
    setApproveTarget(o);
    setNote('');
  };

  const closeApprove = () => {
    setApproveTarget(null);
    setNote('');
  };

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
    mutationFn: async ({ id, stage, reviewNote }: { id: string; stage: Stage; reviewNote?: string }) => {
      const { data, error } = await db.rpc(STAGE_RPC[stage], {
        p_sale_id: id,
        p_note: reviewNote?.trim() || null,
      });
      if (error) throw error;
      return { ...(data as any), stage };
    },
    onSuccess: (data: any) => {
      if (data?.stage === 'cfo') {
        toast.success(
          `${formatUGX(Number(data?.supplier_paid || 0))} paid to the supplier. Daily repayment of ${formatUGX(
            Number(data?.daily_amount || 0),
          )} starts ${data?.repayment_starts_on || 'after the grace period'}.`,
        );
      } else if (data?.stage === 'coo') {
        toast.success('Approved and forwarded to the CFO for supplier payment.');
      } else {
        toast.success('Eligibility verified and forwarded to the COO.');
      }
      closeApprove();
      setDetailsTarget(null);
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not process this application'),
  });

  const reject = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await db.rpc('reject_smartphone_order', { p_sale_id: id, p_reason: reason });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Application declined. No wallet charge applied.');
      setRejectTarget(null);
      setDetailsTarget(null);
      setRejectReason('');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not decline this application'),
  });

  const scoped = useMemo(
    () => (pendingOnly ? orders.filter((o) => isOpen(o.order_status)) : orders),
    [orders, pendingOnly],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((o) =>
      [o.client_name, o.client_phone, o.brand, o.model_type, o.supplier_name]
        .some((v) => (v || '').toLowerCase().includes(q)),
    );
  }, [scoped, search]);

  const opsCount = useMemo(() => orders.filter((o) => isPendingOps(o.order_status)).length, [orders]);
  const cooCount = useMemo(() => orders.filter((o) => isAwaitingCoo(o.order_status)).length, [orders]);
  const cfoCount = useMemo(() => orders.filter((o) => isAwaitingCfo(o.order_status)).length, [orders]);

  const rowBusy = (id: string) =>
    (approve.isPending && approve.variables?.id === id) ||
    (reject.isPending && reject.variables?.id === id);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Smartphone className="h-4 w-4 text-primary" />
          {pendingOnly ? 'Pending applications' : 'Smartphone advance applications'}
          <Badge variant="secondary">{opsCount} awaiting Agent Ops</Badge>
          <Badge variant="outline" className={STATUS_TONE.ops_approved}>{cooCount} awaiting COO</Badge>
          <Badge variant="outline" className={STATUS_TONE.coo_approved}>{cfoCount} awaiting CFO</Badge>
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Agent Ops verifies eligibility (leaderboard position, national ID, workplace visit), the COO approves,
          then the CFO pays the registered supplier directly. Daily wallet deductions start after a 14-day grace
          period.
        </p>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agent, phone, brand, model or supplier"
          className="mt-2 h-9"
        />
      </CardHeader>

      <CardContent className="space-y-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading applications…
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {pendingOnly ? 'No applications awaiting a decision.' : 'No smartphone applications yet.'}
          </p>
        ) : (
          filtered.map((o) => {
            const price = Number(o.total_amount || 0);
            const daily = Number(o.access_daily_amount || 0);
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
                      {o.applicant_rank ? ` · rank #${o.applicant_rank}` : ''}
                    </p>
                  </div>
                  <Badge variant="outline" className={STATUS_TONE[o.order_status] || ''}>
                    {statusLabel(o.order_status)}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="text-[10px] text-muted-foreground">Device</p>
                    <p className="text-xs font-semibold truncate">
                      {[o.brand, o.model_type].filter(Boolean).join(' · ') || '—'}
                    </p>
                  </div>
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="text-[10px] text-muted-foreground">Phone price</p>
                    <p className="text-xs font-semibold">{formatUGX(price)}</p>
                  </div>
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="text-[10px] text-muted-foreground">Period</p>
                    <p className="text-xs font-semibold">
                      {o.advance_period_months ? `${o.advance_period_months} months` : '—'}
                    </p>
                  </div>
                  <div className="rounded-md bg-muted/50 px-2 py-1.5">
                    <p className="text-[10px] text-muted-foreground">Daily</p>
                    <p className="text-xs font-semibold">{daily > 0 ? formatUGX(daily) : '—'}</p>
                  </div>
                </div>

                {o.rejection_reason && (
                  <p className="text-[11px] text-destructive">Declined: {o.rejection_reason}</p>
                )}

                {isOpen(o.order_status) && (
                  <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" onClick={() => openApprove(o)} disabled={rowBusy(o.id)}>
                      {approve.isPending && approve.variables?.id === o.id ? (
                        <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Processing…</>
                      ) : (
                        <><Check className="h-3.5 w-3.5 mr-1" /> {STAGE_CTA[stageOf(o.order_status)]}</>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { setRejectTarget(o); setRejectReason(''); }}
                      disabled={rowBusy(o.id)}
                    >
                      {reject.isPending && reject.variables?.id === o.id ? (
                        <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Declining…</>
                      ) : (
                        <><X className="h-3.5 w-3.5 mr-1" /> Decline</>
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
        <DialogContent className="max-w-md max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-primary" />
              Smartphone advance application
            </DialogTitle>
          </DialogHeader>
          {detailsTarget && (() => {
            const price = Number(detailsTarget.total_amount || 0);
            const daily = Number(detailsTarget.access_daily_amount || 0);
            const days = Number(detailsTarget.access_repayment_days || 0);
            const rows: Array<[string, string]> = [
              ['Agent', detailsTarget.client_name || 'Agent'],
              ['Phone number', detailsTarget.client_phone || '—'],
              ['Leaderboard position', detailsTarget.applicant_rank ? `#${detailsTarget.applicant_rank}` : '—'],
              ['Position ceiling', formatUGX(Number(detailsTarget.rank_cap || 0))],
              ['Submitted', format(new Date(detailsTarget.created_at), 'dd MMM yyyy HH:mm')],
              ['Brand', detailsTarget.brand || '—'],
              ['Model', detailsTarget.model_type || '—'],
              ['Supplier', detailsTarget.supplier_name || (detailsTarget.supplier_id ? 'Registered user' : '—')],
              ['Phone price', formatUGX(price)],
              ['Period', detailsTarget.advance_period_months ? `${detailsTarget.advance_period_months} months` : '—'],
              ['Programme charge', detailsTarget.advance_markup_pct != null ? `${Number(detailsTarget.advance_markup_pct)}%` : '—'],
              ['Total repayable', formatUGX(Number(detailsTarget.total_repayable || 0))],
              ['Daily deduction', daily > 0 ? `${formatUGX(daily)} / day` : '—'],
              ['Repayment days', days > 0 ? String(days) : '—'],
              ['Deductions start', detailsTarget.repayment_starts_on
                ? format(new Date(detailsTarget.repayment_starts_on), 'dd MMM yyyy')
                : '—'],
              ['Amount paid', formatUGX(Number(detailsTarget.amount_paid || 0))],
              ['Outstanding', formatUGX(Number(detailsTarget.amount_outstanding || 0))],
              ['Late charges', formatUGX(Number(detailsTarget.overdue_surcharge_total || 0))],
            ];

            return (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Status</span>
                  <Badge variant="outline" className={STATUS_TONE[detailsTarget.order_status] || ''}>
                    {statusLabel(detailsTarget.order_status)}
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
                  <p className="text-[11px] text-destructive">Declined: {detailsTarget.rejection_reason}</p>
                )}

                {isOpen(detailsTarget.order_status) && (
                  <DialogFooter className="gap-2 sm:gap-2">
                    <Button
                      variant="outline"
                      onClick={() => { setRejectTarget(detailsTarget); setRejectReason(''); }}
                    >
                      <X className="h-3.5 w-3.5 mr-1" /> Decline
                    </Button>
                    <Button disabled={approve.isPending} onClick={() => openApprove(detailsTarget)}>
                      <Check className="h-3.5 w-3.5 mr-1" />
                      {STAGE_CTA[stageOf(detailsTarget.order_status)]}
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
        onOpenChange={(o) => { if (!o && !approve.isPending) closeApprove(); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="h-4 w-4 text-primary" />
              {approveStage === 'cfo'
                ? 'Pay supplier & activate'
                : approveStage === 'coo'
                  ? 'COO approval — forward to CFO'
                  : 'Agent Ops verification — forward to COO'}
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
                  <span className="text-xs text-muted-foreground">Phone price</span>
                  <span className="text-xs font-semibold">{formatUGX(Number(approveTarget.total_amount || 0))}</span>
                </div>
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Supplier</span>
                  <span className="text-xs font-semibold text-right truncate">
                    {approveTarget.supplier_name || (approveTarget.supplier_id ? 'Registered user' : '—')}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Daily deduction</span>
                  <span className="text-xs font-semibold">
                    {Number(approveTarget.access_daily_amount || 0) > 0
                      ? `${formatUGX(Number(approveTarget.access_daily_amount))} / day`
                      : '—'}
                  </span>
                </div>
              </div>

              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note (optional)"
                className="min-h-[64px]"
              />

              <p className="text-[11px] text-muted-foreground">
                {approveStage === 'cfo'
                  ? `${formatUGX(Number(approveTarget.total_amount || 0))} will be paid to the supplier's wallet. Daily wallet deductions begin after the 14-day grace period.`
                  : 'No money moves at this stage — the application moves to the next approver.'}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" disabled={approve.isPending} onClick={closeApprove}>
              Cancel
            </Button>
            <Button
              disabled={approve.isPending || !approveTarget}
              onClick={() =>
                approveTarget &&
                approve.mutate({ id: approveTarget.id, stage: approveStage, reviewNote: note })
              }
            >
              {approve.isPending ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Processing…</>
              ) : (
                <><Check className="h-3.5 w-3.5 mr-1" /> {STAGE_CTA[approveStage]}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rejectTarget} onOpenChange={(o) => { if (!o) setRejectTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Decline smartphone application</DialogTitle>
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
                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Declining…</>
              ) : 'Decline application'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
