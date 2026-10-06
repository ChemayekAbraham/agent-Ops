import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Bike, Check, Edit3, Loader2, X, Download, Award, ShieldCheck, Wrench, TrendingUp, ChevronDown, ChevronUp, FileText } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
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
import { SPIRO_LEASE_PERIODS, spiroLeaseSchedule } from '@/lib/spiroBikeLease';
import { useBikeCatalogCosts, bikeProfit } from '@/hooks/useBikeCatalogCosts';
import { BikeLeaseDetailDialog } from './BikeLeaseDetailDialog';
import { EditBikeApplicationDialog } from './EditBikeApplicationDialog';
import { MotorBikeCatalogDialog } from './MotorBikeCatalogDialog';
import { BikeAssetDetailsDialog } from './BikeAssetDetailsDialog';
import {
  generateSpiroBikeSettlementCertificatePdf,
  downloadSpiroSettlementCertificate,
} from '@/lib/spiroBikeSettlementCertificatePdf';

import { fetchBikeLeaseQueue, type BikeLeaseRecord } from '@/hooks/useBikeLeases';

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
const isApproved = (s: string) => s === 'approved' || s === 'completed';

/**
 * Computes cost price, daily payment and access fee for a bike lease application.
 * Pay figures come from the same reducing-balance schedule the agent is quoted
 * (valuation + 28% monthly fee on the opening principal), not valuation alone.
 */
const getRowPricing = (row: BikeLeaseRow, supplierCost: number | null) => {
  const val = Number(row.valuation_amount || 0);
  const term = Number(row.lease_term_months || 12);
  const schedule = spiroLeaseSchedule(term, val);
  const feePct = schedule.feePct;
  const costPrice = supplierCost;
  const dailyPay = schedule.daily;
  const perCredit = schedule.accessFee;
  const profit = bikeProfit(val, costPrice);
  const dailyRange = `${formatUGX(schedule.firstDaily)} → ${formatUGX(schedule.lastDaily)} per day`;
  return { val, term, feePct, costPrice, dailyPay, perCredit, profit, dailyRange };
};

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
  awaitingExecOnly = false,
  approvedOnly = false,
  stage: stageFilter,
}: {
  pendingOnly?: boolean;
  awaitingExecOnly?: boolean;
  approvedOnly?: boolean;
  stage?: Stage;
} = {}) {
  const queryClient = useQueryClient();
  const supplierCostFor = useBikeCatalogCosts();
  const rowPricing = (row: BikeLeaseRow) => getRowPricing(row, supplierCostFor(row.model_type));
  const [search, setSearch] = useState('');
  const [approveTarget, setApproveTarget] = useState<BikeLeaseRow | null>(null);
  const [approvedValuation, setApprovedValuation] = useState('');
  const [approvedTerm, setApprovedTerm] = useState('12');
  const [rejectTarget, setRejectTarget] = useState<BikeLeaseRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [detailTarget, setDetailTarget] = useState<BikeLeaseRow | null>(null);
  const [editTarget, setEditTarget] = useState<BikeLeaseRow | null>(null);
  const [assetTarget, setAssetTarget] = useState<BikeLeaseRow | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const { data: orders = [], isLoading } = useQuery<BikeLeaseRow[]>({
    queryKey: ['bike-lease-queue'],
    queryFn: async () => {
      return (await fetchBikeLeaseQueue(null)) as BikeLeaseRow[];
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['bike-lease-queue'] });
    queryClient.invalidateQueries({ queryKey: ['agent-products'] });
  };

  const approveStage: Stage = stageFilter || (approveTarget ? stageOf(approveTarget.order_status) : 'ops');

  const canActOnRow = (status: string) => {
    if (!stageFilter) return isOpen(status);
    if (stageFilter === 'ops') return isPending(status);
    if (stageFilter === 'coo') return isAwaitingCoo(status);
    if (stageFilter === 'cfo') return isAwaitingCfo(status);
    return false;
  };

  const openApprove = (o: BikeLeaseRow) => {
    if (!canActOnRow(o.order_status)) return;
    setApproveTarget(o);
    setApprovedValuation(String(Math.round(Number(o.valuation_amount || 0))));
    setApprovedTerm(String(o.lease_term_months || 12));
  };

  const valuationNum = Math.max(0, Math.round(Number(approvedValuation || 0) || 0));
  const termNum = Math.max(1, parseInt(approvedTerm, 10) || 12);
  const approveSchedule = spiroLeaseSchedule(termNum, valuationNum);
  const interestPct = approveSchedule.feePct;
  const perCredit = approveSchedule.accessFee;
  const monthly = approveSchedule.monthly;
  const isOpsDashboard = stageFilter === 'ops' || !stageFilter;
  const approveCostPrice = approveTarget ? supplierCostFor(approveTarget.model_type) : null;
  const approveDailyPay = approveSchedule.daily;
  const approveDailyRange = `${formatUGX(approveSchedule.firstDaily)} → ${formatUGX(approveSchedule.lastDaily)}`;

  const approve = useMutation({
    mutationFn: async ({ id, stage }: { id: string; stage: Stage }) => {
      const fn =
        stage === 'cfo'
          ? 'cfo_disburse_bike_lease'
          : stage === 'coo'
            ? 'coo_approve_bike_lease'
            : 'agent_ops_verify_bike_lease';
      const args =
        stage === 'cfo'
          ? // Locked: the CFO releases exactly the COO-approved valuation, which
            // the server reads from the application when no price is sent.
            { p_sale_id: id }
          : stage === 'coo'
            ? { p_sale_id: id, p_valuation: valuationNum, p_lease_term_months: termNum }
            : { p_sale_id: id };
      const { data, error } = await db.rpc(fn, args);
      if (error) throw error;
      return { ...(data as any), stage };
    },
    onSuccess: (data: any) => {
      toast.success(
        data?.stage === 'cfo'
          ? `Disbursed ${formatUGX(Number(data?.valuation || 0))} to the agent wallet. Lease active — 28% monthly reducing-balance recovery started.`
          : data?.stage === 'coo'
            ? `Approved at ${formatUGX(Number(data?.valuation || 0))} and forwarded to the CFO for disbursement.`
            : 'Verified by Agent Ops and forwarded to the COO for approval.',
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

  const scoped = useMemo(() => {
    let rows = orders;
    // A dashboard scoped to one step only ever sees the rows waiting on it,
    // plus the rows it has already handled so officers can follow them through.
    if (stageFilter === 'coo') {
      rows = rows.filter((o) => isAwaitingCoo(o.order_status) || !!o.coo_approved_at);
    } else if (stageFilter === 'cfo') {
      rows = rows.filter((o) => isAwaitingCfo(o.order_status) || !!o.cfo_disbursed_at);
    }
    if (approvedOnly) {
      return rows.filter((o) => isApproved(o.order_status));
    }
    if (awaitingExecOnly) {
      return rows.filter((o) => isAwaitingCoo(o.order_status) || isAwaitingCfo(o.order_status));
    }
    if (pendingOnly) {
      if (stageFilter === 'ops') {
        return rows.filter((o) => isPending(o.order_status));
      }
      return rows.filter((o) => isOpen(o.order_status));
    }
    return rows;
  }, [orders, pendingOnly, awaitingExecOnly, approvedOnly, stageFilter]);

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
  const cooCount = useMemo(() => orders.filter((o) => isAwaitingCoo(o.order_status)).length, [orders]);
  const cfoCount = useMemo(() => orders.filter((o) => isAwaitingCfo(o.order_status)).length, [orders]);
  const execCount = useMemo(() => cooCount + cfoCount, [cooCount, cfoCount]);
  const approvedCount = useMemo(() => orders.filter((o) => isApproved(o.order_status)).length, [orders]);

  const rowBusy = (id: string) =>
    (approve.isPending && approve.variables?.id === id) ||
    (reject.isPending && reject.variables?.id === id);

  return (
    <Card className="overflow-x-hidden max-w-full">
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Bike className="h-4 w-4 text-primary" />
            {approvedOnly
              ? 'Approved Spiro bike lease applications'
              : awaitingExecOnly
                ? 'Applications awaiting COO & CFO approval'
                : pendingOnly
                  ? 'Pending Spiro bike lease applications'
                  : 'Spiro bike lease applications'}
            {approvedOnly ? (
              approvedCount > 0 && (
                <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30">
                  {approvedCount} approved
                </Badge>
              )
            ) : awaitingExecOnly ? (
              execCount > 0 && (
                <Badge variant="secondary" className="bg-sky-500/15 text-sky-600 border-sky-500/30">
                  {execCount} in executive review
                </Badge>
              )
            ) : (
              <>
                {(!stageFilter || stageFilter === 'ops') && pendingCount > 0 && (
                  <Badge variant="secondary">{pendingCount} awaiting Agent Ops</Badge>
                )}
                {(!stageFilter || stageFilter === 'coo') && cooCount > 0 && (
                  <Badge variant="secondary">{cooCount} awaiting COO</Badge>
                )}
                {(!stageFilter || stageFilter === 'cfo') && cfoCount > 0 && (
                  <Badge variant="secondary">{cfoCount} awaiting CFO</Badge>
                )}
              </>
            )}
          </CardTitle>
          {!stageFilter && <MotorBikeCatalogDialog />}
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
            {approvedOnly
              ? 'No approved bike lease applications yet.'
              : awaitingExecOnly
                ? 'No applications currently awaiting COO or CFO approval.'
                : pendingOnly
                  ? 'No bike lease applications awaiting review.'
                  : 'No Spiro bike lease applications yet.'}
          </p>
        ) : (
          <>
            {/* Mobile cards */}
            <div className="space-y-2.5 md:hidden">
              {filtered.map((o) => {
                const pricing = rowPricing(o);
                const isExpanded = expandedIds.has(o.id);
                return (
                  <div
                    key={o.id}
                    className={cn(
                      "rounded-xl border bg-card transition-all shadow-xs overflow-hidden",
                      isExpanded ? "border-primary/40 ring-1 ring-primary/20" : "hover:border-border"
                    )}
                  >
                    {/* Card Header - tap to open full application details dossier */}
                    <div
                      className="flex items-center justify-between gap-2 p-3 cursor-pointer select-none hover:bg-muted/30 active:bg-muted/50 transition-colors"
                      onClick={() => setDetailTarget(o)}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <p className="text-sm font-semibold truncate text-foreground hover:text-primary transition-colors">{o.client_name || 'Agent'}</p>
                          <Badge variant="outline" className={cn("shrink-0 text-[10px] px-1.5 py-0 font-medium", STATUS_TONE[o.order_status] || '')}>
                            {statusLabel(o.order_status)}
                          </Badge>
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                          {o.model_type || 'Spiro bike'} · {o.client_phone || '—'}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <div className="text-right">
                          <p className="text-xs font-bold text-foreground tabular-nums">
                            {formatUGX(Number(o.amount_outstanding || o.valuation_amount || 0))}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {Number(o.amount_outstanding || 0) > 0 ? 'outstanding' : 'valuation'}
                          </p>
                        </div>
                        <button
                          type="button"
                          aria-label={isExpanded ? "Collapse quick summary" : "Expand quick summary"}
                          className="h-7 w-7 rounded-full bg-muted/60 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(o.id);
                          }}
                        >
                          {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>

                    {/* Expandable Details & Actions */}
                    {isExpanded && (
                      <div className="px-3 pb-3 pt-1 border-t border-border/60 space-y-3 bg-card">
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-[11px] bg-muted/20 p-2.5 rounded-lg border border-border/40">
                          {isOpsDashboard ? (
                            <>
                              <span className="text-muted-foreground">Bike cost price</span>
                              <span className="text-right font-semibold text-primary tabular-nums">
                                {pricing.costPrice == null ? 'Not in catalog' : formatUGX(pricing.costPrice)}
                              </span>
                              <span className="text-muted-foreground">Our profit</span>
                              <span className="text-right font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                                {pricing.profit == null ? 'Not in catalog' : formatUGX(pricing.profit)}
                              </span>
                              <span className="text-muted-foreground">Avg. daily pay</span>
                              <span className="text-right font-semibold tabular-nums" title={pricing.dailyRange}>
                                {formatUGX(pricing.dailyPay)}/day
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="text-muted-foreground">Valuation</span>
                              <span className="text-right font-semibold tabular-nums">{formatUGX(Number(o.valuation_amount || 0))}</span>
                            </>
                          )}
                          <span className="text-muted-foreground">Lease term</span>
                          <span className="text-right font-semibold tabular-nums">{o.lease_term_months || 12} months</span>
                          <span className="text-muted-foreground">Access fee</span>
                          <span className="text-right font-semibold tabular-nums">{formatUGX(pricing.perCredit)} ({pricing.feePct}%)</span>
                          <span className="text-muted-foreground">Outstanding</span>
                          <span className="text-right font-semibold text-destructive tabular-nums">{formatUGX(Number(o.amount_outstanding || 0))}</span>
                        </div>

                        {/* Action buttons with no collision */}
                        <div className="space-y-2 pt-1" onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 w-full text-xs font-semibold border-primary/40 text-primary hover:bg-primary/10 gap-1.5 shadow-2xs"
                            onClick={() => setDetailTarget(o)}
                          >
                            <FileText className="h-3.5 w-3.5" /> View Full Application Dossier
                          </Button>

                          <div className="grid grid-cols-2 gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs gap-1 border-border text-foreground hover:text-primary hover:bg-primary/10 font-medium"
                              onClick={() => setEditTarget(o)}
                            >
                              <Edit3 className="h-3.5 w-3.5" /> Edit Price
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs gap-1 text-muted-foreground hover:text-primary hover:bg-primary/10 font-medium"
                              onClick={() => setAssetTarget(o)}
                            >
                              <Wrench className="h-3.5 w-3.5" /> Asset Info
                            </Button>
                          </div>

                          {canActOnRow(o.order_status) && (
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                className="h-8 flex-1 text-xs font-semibold shadow-xs"
                                disabled={rowBusy(o.id)}
                                onClick={() => openApprove(o)}
                              >
                                {ACTION_LABEL[stageFilter || stageOf(o.order_status)]}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 px-3 text-xs text-destructive hover:bg-destructive/10 border-destructive/30 font-medium shrink-0"
                                disabled={rowBusy(o.id)}
                                onClick={() => setRejectTarget(o)}
                              >
                                <X className="h-3.5 w-3.5 mr-1" /> Reject
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left py-2 pr-3 font-medium">Agent</th>
                    <th className="text-left py-2 pr-3 font-medium">Model</th>
                    {isOpsDashboard ? (
                      <>
                        <th className="text-right py-2 pr-3 font-medium">Bike Cost Price</th>
                        <th className="text-right py-2 pr-3 font-medium">Our Profit</th>
                        <th className="text-right py-2 pr-3 font-medium">Avg. Daily Pay</th>
                      </>
                    ) : (
                      <th className="text-right py-2 pr-3 font-medium">Valuation</th>
                    )}
                    <th className="text-right py-2 pr-3 font-medium">Term</th>
                    <th className="text-right py-2 pr-3 font-medium">Access fee</th>
                    <th className="text-right py-2 pr-3 font-medium">Outstanding</th>
                    <th className="text-left py-2 pr-3 font-medium">Status</th>
                    <th className="text-left py-2 pr-3 font-medium">Submitted</th>
                    <th className="text-right py-2 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((o) => {
                    const pricing = rowPricing(o);
                    return (
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
                        {isOpsDashboard ? (
                          <>
                            <td className="py-2 pr-3 text-right font-semibold text-primary">
                              {pricing.costPrice == null ? 'Not in catalog' : formatUGX(pricing.costPrice)}
                            </td>
                            <td className="py-2 pr-3 text-right font-semibold text-emerald-600 dark:text-emerald-400">
                              {pricing.profit == null ? 'Not in catalog' : formatUGX(pricing.profit)}
                            </td>
                            <td className="py-2 pr-3 text-right font-medium" title={pricing.dailyRange}>
                              {formatUGX(pricing.dailyPay)}/day
                            </td>
                          </>
                        ) : (
                          <td className="py-2 pr-3 text-right font-semibold">
                            {formatUGX(Number(o.valuation_amount || 0))}
                          </td>
                        )}
                        <td className="py-2 pr-3 text-right">{o.lease_term_months || 12}m</td>
                        <td className="py-2 pr-3 text-right">{formatUGX(pricing.perCredit)} <span className="text-[10px] text-muted-foreground">({pricing.feePct}%)</span></td>
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
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-primary hover:bg-primary/10"
                            title="Record bike asset details"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAssetTarget(o);
                            }}
                          >
                            <Wrench className="h-3.5 w-3.5" />
                          </Button>
                          {canActOnRow(o.order_status) ? (
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
                                <span className="ml-1">{SHORT_ACTION_LABEL[stageFilter || stageOf(o.order_status)]}</span>
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
                            <div className="flex items-center gap-1">
                              {isApproved(o.order_status) && Number(o.amount_outstanding || 0) <= 0 && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs gap-1 border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10"
                                  title="Download Certificate of Full Settlement"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    try {
                                      const blob = await generateSpiroBikeSettlementCertificatePdf({
                                        agentName: o.client_name || 'Agent',
                                        agentPhone: o.client_phone || null,
                                        modelType: o.model_type || 'Spiro electric bike',
                                        trackingReference: o.tracking_reference || null,
                                        valuationAmount: Number(o.valuation_amount || 0),
                                        totalRepaid: Number(o.amount_paid || o.valuation_amount || 0),
                                        leaseTermMonths: Number(o.lease_term_months || 12),
                                        completedAt: o.lease_activated_at || o.cfo_disbursed_at || o.created_at,
                                        saleId: o.id,
                                      });
                                      downloadSpiroSettlementCertificate(blob, o.client_name || 'Agent', o.tracking_reference);
                                      toast.success('Certificate of Full Settlement downloaded');
                                    } catch (err: any) {
                                      toast.error('Could not generate certificate: ' + (err.message || 'Unknown error'));
                                    }
                                  }}
                                >
                                  <Download className="h-3 w-3" />
                                  <span className="hidden xl:inline">Cert</span>
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs text-muted-foreground hover:text-primary"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDetailTarget(o);
                                }}
                              >
                                Details
                              </Button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
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
              {approveStage === 'cfo'
                ? 'Disburse to the agent wallet & activate lease'
                : approveStage === 'coo'
                  ? 'COO approval — valuation & lease terms'
                  : 'Agent Ops verification'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {approveStage === 'cfo'
                ? 'The money goes into the ordering agent’s own wallet and daily wallet recovery starts immediately.'
                : approveStage === 'coo'
                  ? 'COO approval moves no money — the file is forwarded to the CFO for disbursement.'
                  : 'Verification moves no money — the file is forwarded to the COO for approval.'}
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

              {approveStage === 'ops' ? (
                <div className="space-y-1.5">
                  <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs flex justify-between">
                    <span className="text-muted-foreground">Bike cost price</span>
                    <span className="font-semibold text-primary">{approveCostPrice == null ? 'Not in catalog' : formatUGX(approveCostPrice)}</span>
                  </div>
                  <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs flex justify-between">
                    <span className="text-muted-foreground">Avg. daily pay</span>
                    <span className="font-semibold" title={`${approveDailyRange} per day`}>{formatUGX(approveDailyPay)}/day</span>
                  </div>
                </div>
              ) : approveStage === 'cfo' ? (
                <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs flex justify-between">
                  <span className="text-muted-foreground">COO-approved bike valuation</span>
                  <span className="font-semibold">{formatUGX(valuationNum)}</span>
                </div>
              ) : (
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
              )}

              {approveStage === 'coo' && (
                <div className="space-y-1">
                  <Label className="text-xs">Lease term</Label>
                  <Select value={approvedTerm} onValueChange={setApprovedTerm}>
                    <SelectTrigger className="h-9 text-xs">
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
                  <span className="text-muted-foreground">Access fee ({termNum}m, 28%/month reducing)</span>
                  <span className="font-semibold">
                    {formatUGX(perCredit)} ({interestPct}%)
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Avg. monthly pay</span>
                  <span className="font-semibold">{formatUGX(monthly)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">First → last daily</span>
                  <span className="font-semibold tabular-nums">{approveDailyRange}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Our profit</span>
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                    {approveCostPrice == null ? 'Not in catalog' : formatUGX(valuationNum - approveCostPrice)}
                  </span>
                </div>
                {approveStage === 'ops' ? (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Avg. daily pay</span>
                    <span className="font-semibold text-primary">{formatUGX(approveDailyPay)}/day</span>
                  </div>
                ) : (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Full recovery target</span>
                    <span className="font-semibold">{formatUGX(approveSchedule.total)} over {termNum} months</span>
                  </div>
                )}
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
              {ACTION_LABEL[approveStage]}
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
        stage={stageFilter || 'ops'}
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

      {/* Bike Asset Details Dialog */}
      <BikeAssetDetailsDialog
        lease={assetTarget as unknown as BikeLeaseRecord | null}
        open={!!assetTarget}
        onOpenChange={(v) => { if (!v) setAssetTarget(null); }}
      />

    </Card>
  );
}

export default BikeLeaseApprovalQueue;
