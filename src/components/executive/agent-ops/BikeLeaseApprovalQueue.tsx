import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Bike, Check, Edit3, Loader2, X } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import { LEASE_TERMS } from '@/components/merchandise/SpiroBikeOrderDialog';
import { BikeLeaseDetailDialog } from './BikeLeaseDetailDialog';
import { EditBikeApplicationDialog } from './EditBikeApplicationDialog';
import { MotorBikeCatalogDialog } from './MotorBikeCatalogDialog';

const db = supabase as any;

interface BikeLeaseRow {
  id: string;
  customer_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  model_type: string | null;
  valuation_amount: number | null;
  payment_projection: number | null;
  lease_term_months: number | null;
  lease_daily_rate: number | null;
  amount_outstanding: number | null;
  amount_paid: number | null;
  order_status: string;
  rejection_reason: string | null;
  created_at: string;
  ops_approved_at?: string | null;
  coo_approved_at: string | null;
  cfo_disbursed_at: string | null;
  lease_activated_at: string | null;
  disbursed_amount: number | null;
  tracking_reference: string | null;
}

const STATUS_TONE: Record<string, string> = {
  submitted: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  pending_approval: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  ops_approved: 'bg-indigo-500/15 text-indigo-600 border-indigo-500/30',
  coo_approved: 'bg-sky-500/15 text-sky-600 border-sky-500/30',
  approved: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  completed: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  rejected: 'bg-destructive/15 text-destructive border-destructive/30',
};

const STATUS_LABEL: Record<string, string> = {
  submitted: 'Submitted — awaiting Agent Ops',
  pending_approval: 'Submitted — awaiting Agent Ops',
  ops_approved: 'Agent Ops verified — awaiting COO',
  coo_approved: 'COO approved — awaiting CFO',
  approved: 'Funds disbursed & active lease',
  completed: 'Lease completed',
};

type Stage = 'ops' | 'coo' | 'cfo';

const statusLabel = (s: string) => STATUS_LABEL[s] || s.replace(/_/g, ' ');
const isPending = (s: string) => s === 'submitted' || s === 'pending_approval';
const isAwaitingCoo = (s: string) => s === 'ops_approved';
const isAwaitingCfo = (s: string) => s === 'coo_approved';
const isOpen = (s: string) => isPending(s) || isAwaitingCoo(s) || isAwaitingCfo(s);

/** The step a row is currently waiting on. */
const stageOf = (s: string): Stage => (isAwaitingCfo(s) ? 'cfo' : isAwaitingCoo(s) ? 'coo' : 'ops');

const ACTION_LABEL: Record<Stage, string> = {
  ops: 'Verify & send to COO',
  coo: 'Approve & send to CFO',
  cfo: 'Disburse to agent wallet',
};

const SHORT_ACTION_LABEL: Record<Stage, string> = {
  ops: 'Verify',
  coo: 'Approve',
  cfo: 'Disburse',
};

/**
 * Shared Spiro / motor bike lease queue used by three dashboards.
 *
 * The application route is Agent Ops verification → COO approval → CFO
 * disbursement into the ordering agent's own wallet. Pass `stage` to show only
 * the rows a dashboard is responsible for; Agent Ops sees every row and so
 * tracks the status at every step.
 */
export function BikeLeaseApprovalQueue({
  pendingOnly = false,
  stage: stageFilter,
}: { pendingOnly?: boolean; stage?: Stage } = {}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [approveTarget, setApproveTarget] = useState<BikeLeaseRow | null>(null);
  const [approvedValuation, setApprovedValuation] = useState('');
  const [approvedTerm, setApprovedTerm] = useState('12');
  const [rejectTarget, setRejectTarget] = useState<BikeLeaseRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [detailTarget, setDetailTarget] = useState<BikeLeaseRow | null>(null);
  const [editTarget, setEditTarget] = useState<BikeLeaseRow | null>(null);

  const { data: orders = [], isLoading } = useQuery<BikeLeaseRow[]>({
    queryKey: ['bike-lease-queue'],
    queryFn: async () => {
      const { data, error } = await db.rpc('list_bike_lease_orders', { p_status: null });
      if (error) throw error;
      return (data || []) as BikeLeaseRow[];
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['bike-lease-queue'] });
    queryClient.invalidateQueries({ queryKey: ['agent-products'] });
  };

  const approveStage: 'coo' | 'cfo' =
    approveTarget && isAwaitingCfo(approveTarget.order_status) ? 'cfo' : 'coo';

  const openApprove = (o: BikeLeaseRow) => {
    setApproveTarget(o);
    setApprovedValuation(String(Math.round(Number(o.valuation_amount || 0))));
    setApprovedTerm(String(o.lease_term_months || 12));
  };

  const valuationNum = Math.max(0, Math.round(Number(approvedValuation || 0) || 0));
  const termNum = Math.max(1, parseInt(approvedTerm, 10) || 12);
  const rate = Number(approveTarget?.lease_daily_rate || 0.15);
  const perCredit = Math.round(valuationNum * rate);
  const monthly = valuationNum > 0 ? Math.round(valuationNum / termNum) : 0;



  const approve = useMutation({
    mutationFn: async ({ id, stage }: { id: string; stage: 'coo' | 'cfo' }) => {
      const { data, error } = await db.rpc(
        stage === 'cfo' ? 'cfo_disburse_bike_lease' : 'coo_approve_bike_lease',
        stage === 'cfo'
          ? { p_sale_id: id, p_valuation: valuationNum }
          : { p_sale_id: id, p_valuation: valuationNum, p_lease_term_months: termNum },
      );
      if (error) throw error;
      return { ...(data as any), stage };
    },
    onSuccess: (data: any) => {
      toast.success(
        data?.stage === 'cfo'
          ? `Bike released at ${formatUGX(Number(data?.valuation || 0))}. Lease active — ${Math.round(Number(data?.daily_rate || 0.15) * 100)}% wallet recovery started.`
          : `Approved at ${formatUGX(Number(data?.valuation || 0))} and forwarded to the CFO for bike release.`,
      );
      setApproveTarget(null);
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not process this application'),
  });

  const reject = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await db.rpc('reject_bike_lease', { p_sale_id: id, p_reason: reason });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Application rejected. No lease was created.');
      setRejectTarget(null);
      setRejectReason('');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Could not reject this application'),
  });

  const scoped = useMemo(
    () => (pendingOnly ? orders.filter((o) => isOpen(o.order_status)) : orders),
    [orders, pendingOnly],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((o) =>
      [o.client_name, o.client_phone, o.model_type, o.tracking_reference].some((v) =>
        (v || '').toLowerCase().includes(q),
      ),
    );
  }, [scoped, search]);

  const pendingCount = useMemo(() => orders.filter((o) => isPending(o.order_status)).length, [orders]);
  const cfoCount = useMemo(() => orders.filter((o) => isAwaitingCfo(o.order_status)).length, [orders]);

  const rowBusy = (id: string) =>
    (approve.isPending && approve.variables?.id === id) ||
    (reject.isPending && reject.variables?.id === id);

  return (
    <Card className="overflow-x-hidden max-w-full">
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Bike className="h-4 w-4 text-primary" />
            Spiro bike lease applications
            {pendingCount > 0 && <Badge variant="secondary">{pendingCount} awaiting COO</Badge>}
            {cfoCount > 0 && <Badge variant="secondary">{cfoCount} awaiting CFO</Badge>}
          </CardTitle>
          <MotorBikeCatalogDialog />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          placeholder="Search agent, phone, model or tracking reference"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 max-w-sm"
        />

        {isLoading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading applications…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No Spiro bike lease applications yet.
          </p>
        ) : (
          <>
            {/* Mobile cards */}
            <div className="space-y-2 md:hidden">
              {filtered.map((o) => (
                <div
                  key={o.id}
                  className="rounded-xl border bg-card p-3 space-y-2 cursor-pointer hover:bg-muted/40 transition-colors shadow-sm"
                  onClick={() => setDetailTarget(o)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{o.client_name || 'Agent'}</p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {o.model_type || 'Spiro bike'} · {o.client_phone || '—'}
                      </p>
                    </div>
                    <Badge variant="outline" className={`shrink-0 text-[10px] ${STATUS_TONE[o.order_status] || ''}`}>
                      {statusLabel(o.order_status)}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-[11px]">
                    <span className="text-muted-foreground">Valuation</span>
                    <span className="text-right font-semibold">{formatUGX(Number(o.valuation_amount || 0))}</span>
                    <span className="text-muted-foreground">Lease term</span>
                    <span className="text-right font-semibold">{o.lease_term_months || 12} months</span>
                    <span className="text-muted-foreground">Recovery / credit</span>
                    <span className="text-right font-semibold">{formatUGX(Number(o.payment_projection || 0))}</span>
                    <span className="text-muted-foreground">Outstanding</span>
                    <span className="text-right font-semibold">{formatUGX(Number(o.amount_outstanding || 0))}</span>
                  </div>
                  <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 pt-1 border-t" onClick={(e) => e.stopPropagation()}>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 px-2.5 text-xs gap-1 border-primary/30 text-primary hover:bg-primary/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditTarget(o);
                      }}
                    >
                      <Edit3 className="h-3.5 w-3.5" /> Edit Price
                    </Button>
                    {isOpen(o.order_status) && (
                      <>
                        <Button
                          size="sm"
                          className="h-8 flex-1 text-xs"
                          disabled={rowBusy(o.id)}
                          onClick={(e) => {
                            e.stopPropagation();
                            openApprove(o);
                          }}
                        >
                          {isAwaitingCfo(o.order_status) ? 'Release & activate' : 'Approve & send to CFO'}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs text-destructive"
                          disabled={rowBusy(o.id)}
                          onClick={(e) => {
                            e.stopPropagation();
                            setRejectTarget(o);
                          }}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left py-2 pr-3 font-medium">Agent</th>
                    <th className="text-left py-2 pr-3 font-medium">Model</th>
                    <th className="text-right py-2 pr-3 font-medium">Valuation</th>
                    <th className="text-right py-2 pr-3 font-medium">Term</th>
                    <th className="text-right py-2 pr-3 font-medium">Recovery / credit</th>
                    <th className="text-right py-2 pr-3 font-medium">Outstanding</th>
                    <th className="text-left py-2 pr-3 font-medium">Status</th>
                    <th className="text-left py-2 pr-3 font-medium">Submitted</th>
                    <th className="text-right py-2 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((o) => (
                    <tr
                      key={o.id}
                      className="border-b last:border-0 cursor-pointer hover:bg-muted/30 transition-colors group"
                      onClick={() => setDetailTarget(o)}
                    >
                      <td className="py-2 pr-3">
                        <p className="font-medium group-hover:text-primary transition-colors">{o.client_name || 'Agent'}</p>
                        <p className="text-[11px] text-muted-foreground">{o.client_phone || '—'}</p>
                      </td>
                      <td className="py-2 pr-3">{o.model_type || 'Spiro bike'}</td>
                      <td className="py-2 pr-3 text-right font-semibold">
                        {formatUGX(Number(o.valuation_amount || 0))}
                      </td>
                      <td className="py-2 pr-3 text-right">{o.lease_term_months || 12}m</td>
                      <td className="py-2 pr-3 text-right">{formatUGX(Number(o.payment_projection || 0))}</td>
                      <td className="py-2 pr-3 text-right">{formatUGX(Number(o.amount_outstanding || 0))}</td>
                      <td className="py-2 pr-3">
                        <Badge variant="outline" className={`text-[10px] ${STATUS_TONE[o.order_status] || ''}`}>
                          {statusLabel(o.order_status)}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {format(new Date(o.created_at), 'd MMM yyyy')}
                      </td>
                      <td className="py-2 text-right">
                        <div className="flex justify-end items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-primary hover:bg-primary/10"
                            title="Edit application price & details"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditTarget(o);
                            }}
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            <span className="hidden lg:inline">Edit</span>
                          </Button>
                          {isOpen(o.order_status) ? (
                            <>
                              <Button
                                size="sm"
                                className="h-7 text-xs"
                                disabled={rowBusy(o.id)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openApprove(o);
                                }}
                              >
                                {rowBusy(o.id) ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Check className="h-3.5 w-3.5" />
                                )}
                                <span className="ml-1">{isAwaitingCfo(o.order_status) ? 'Release' : 'Approve'}</span>
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs text-destructive"
                                disabled={rowBusy(o.id)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRejectTarget(o);
                                }}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>


      {/* Approve / release dialog with the payment recovery projection */}
      <Dialog open={!!approveTarget} onOpenChange={(o) => { if (!o) setApproveTarget(null); }}>
        <DialogContent className="w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] sm:w-full sm:max-w-md max-h-[90dvh] overflow-y-auto overflow-x-hidden p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>
              {approveStage === 'cfo' ? 'Release bike & activate lease' : 'COO approval — valuation & lease terms'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {approveStage === 'cfo'
                ? 'Releasing the bike activates the lease and starts wallet recovery. No cash is credited to the agent wallet.'
                : 'COO approval moves no money — the file is forwarded to the CFO for bike release.'}
            </DialogDescription>
          </DialogHeader>

          {approveTarget && (
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Agent</span>
                  <span className="font-semibold">{approveTarget.client_name || 'Agent'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Model</span>
                  <span className="font-semibold">{approveTarget.model_type || 'Spiro bike'}</span>
                </div>
              </div>



              <div className="space-y-1">
                <Label className="text-xs">Approved bike valuation (UGX)</Label>
                <Input
                  type="number"
                  min={100000}
                  step={50000}
                  inputMode="numeric"
                  value={approvedValuation}
                  onChange={(e) => setApprovedValuation(e.target.value)}
                />
              </div>

              {approveStage === 'coo' && (
                <div className="space-y-1">
                  <Label className="text-xs">Lease term</Label>
                  <Select value={approvedTerm} onValueChange={setApprovedTerm}>
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LEASE_TERMS.map((t) => (
                        <SelectItem key={t} value={String(t)} className="text-sm">
                          {t} months
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                  Payment recovery projection
                </p>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Recovered per wallet credit</span>
                  <span className="font-semibold">
                    {formatUGX(perCredit)} ({Math.round(rate * 100)}%)
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Monthly equivalent</span>
                  <span className="font-semibold">{formatUGX(monthly)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Full recovery target</span>
                  <span className="font-semibold">{formatUGX(valuationNum)} over {termNum} months</span>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setApproveTarget(null)} disabled={approve.isPending}>
              Cancel
            </Button>
            <Button
              disabled={approve.isPending || valuationNum < 100000}
              onClick={() => approveTarget && approve.mutate({ id: approveTarget.id, stage: approveStage })}
            >
              {approve.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
              {approveStage === 'cfo' ? 'Release & activate lease' : 'Approve & send to CFO'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={!!rejectTarget} onOpenChange={(o) => { if (!o) { setRejectTarget(null); setRejectReason(''); } }}>
        <DialogContent className="w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] sm:w-full sm:max-w-md overflow-x-hidden p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>Reject bike lease application</DialogTitle>
            <DialogDescription className="text-xs">
              Give a reason of at least 10 characters. It is recorded in the audit trail.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            placeholder="Reason for rejection"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRejectTarget(null)} disabled={reject.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={reject.isPending || rejectReason.trim().length < 10}
              onClick={() => rejectTarget && reject.mutate({ id: rejectTarget.id, reason: rejectReason.trim() })}
            >
              {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
              Reject application
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Full Application Details Dialog */}
      <BikeLeaseDetailDialog
        order={detailTarget}
        open={!!detailTarget}
        onOpenChange={(v) => { if (!v) setDetailTarget(null); }}
        onApprove={(ord) => openApprove(ord)}
        onReject={(ord) => setRejectTarget(ord)}
        onEditPrice={(ord) => setEditTarget(ord)}
      />

      {/* Edit Application Price & Terms Dialog */}
      <EditBikeApplicationDialog
        order={editTarget}
        open={!!editTarget}
        onOpenChange={(v) => { if (!v) setEditTarget(null); }}
        onSuccess={() => {
          if (detailTarget && editTarget && detailTarget.id === editTarget.id) {
            setDetailTarget(null);
          }
        }}
      />
    </Card>
  );
}

export default BikeLeaseApprovalQueue;
