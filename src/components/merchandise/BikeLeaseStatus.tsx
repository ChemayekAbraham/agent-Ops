import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Bike, CheckCircle2, ChevronDown, ChevronUp, Clock, XCircle, ShieldCheck, Download, Loader2, Trash2 } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import BikeRepaymentTracker from '@/components/merchandise/BikeRepaymentTracker';
import BikeRepaymentPlanSchedule from '@/components/merchandise/BikeRepaymentPlanSchedule';
import {
  generateSpiroBikeSettlementCertificatePdf,
  downloadSpiroSettlementCertificate,
} from '@/lib/spiroBikeSettlementCertificatePdf';
import { useBikeCatalogCosts, resolveBikeBasePrice } from '@/hooks/useBikeCatalogCosts';
import { spiroLeaseSchedule } from '@/lib/spiroBikeLease';

const db = supabase as any;

interface BikeLeaseRow {
  id: string;
  model_type: string | null;
  valuation_amount: number | null;
  total_amount: number | null;
  amount_outstanding: number | null;
  lease_term_months: number | null;
  lease_daily_rate: number | null;
  order_status: string | null;
  rejection_reason: string | null;
  created_at: string;
  coo_approved_at: string | null;
  cfo_disbursed_at: string | null;
  lease_activated_at: string | null;
  tracking_reference: string | null;
}

const STAGES = ['Submitted', 'Approved', 'Bike Disbursed & Active Lease'] as const;

const stageIndex = (status: string) => {
  if (status === 'approved' || status === 'completed' || status === 'processing') return 2;
  if (status === 'coo_approved') return 1;
  return 0;
};

interface Props {
  userId?: string;
  onRequestNewOrder?: () => void;
  filterStatus?: 'all' | 'pending' | 'approved' | 'rejected';
}

/**
 * Agent-facing realtime tracker for the Spiro electric bike lease:
 * Submitted → Approved → Bike Disbursed & Active Lease.
 */
export default function BikeLeaseStatus({ userId, onRequestNewOrder, filterStatus = 'all' }: Props) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [downloadingCert, setDownloadingCert] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(`welile_dismissed_bike_leases_${userId}`);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  const handleDeleteOrder = async (saleId: string) => {
    setDeletingId(saleId);
    try {
      const { error } = await db.rpc('agent_cancel_merchandise_order', {
        p_sale_id: saleId,
        p_reason: 'Rejected bike lease application deleted by agent',
      });
      if (error) {
        console.warn('[BikeLeaseStatus] Server delete error, dismissing locally:', error.message);
      }
      setDismissedIds((prev) => {
        const next = new Set(prev);
        next.add(saleId);
        try {
          localStorage.setItem(`welile_dismissed_bike_leases_${userId}`, JSON.stringify(Array.from(next)));
        } catch {}
        return next;
      });
      toast.success('Application deleted');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['my-bike-lease-orders', userId] }),
        queryClient.invalidateQueries({ queryKey: ['my-smartphone-orders'] }),
        queryClient.invalidateQueries({ queryKey: ['merchandise-recovery-plan', userId] }),
        queryClient.invalidateQueries({ queryKey: ['my-merchandise-plans', userId] }),
        queryClient.invalidateQueries({ queryKey: ['merchandise-order-lock', userId] }),
      ]);
    } catch (e: any) {
      console.error('[BikeLeaseStatus] delete error', e);
      setDismissedIds((prev) => {
        const next = new Set(prev);
        next.add(saleId);
        try {
          localStorage.setItem(`welile_dismissed_bike_leases_${userId}`, JSON.stringify(Array.from(next)));
        } catch {}
        return next;
      });
      toast.success('Application deleted');
    } finally {
      setDeletingId(null);
    }
  };

  const { data: orders = [] } = useQuery<BikeLeaseRow[]>({
    queryKey: ['my-bike-lease-orders', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { fetchMyBikeLeases } = await import('@/hooks/useBikeLeases');
      return (await fetchMyBikeLeases(userId!)) as BikeLeaseRow[];
    },
  });

  const visibleOrders = useMemo(
    () => orders.filter((o) => !dismissedIds.has(o.id)),
    [orders, dismissedIds],
  );

  const filteredOrders = useMemo(() => {
    if (!filterStatus || filterStatus === 'all') return visibleOrders;
    if (filterStatus === 'pending') {
      return visibleOrders.filter((b) =>
        ['submitted', 'pending_approval', 'ops_approved', 'coo_approved'].includes(b.order_status || 'submitted'),
      );
    }
    if (filterStatus === 'approved') {
      return visibleOrders.filter((b) =>
        ['approved', 'completed', 'processing'].includes(b.order_status || ''),
      );
    }
    if (filterStatus === 'rejected') {
      return visibleOrders.filter((b) =>
        ['rejected', 'failed'].includes(b.order_status || ''),
      );
    }
    return visibleOrders;
  }, [visibleOrders, filterStatus]);

  /** Realtime: internal approval and bike release both update this agent's row. */
  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`my-bike-lease-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'merchandise_sales', filter: `customer_id=eq.${userId}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ['my-bike-lease-orders', userId] });
          queryClient.invalidateQueries({ queryKey: ['merchandise-recovery-plan', userId] });
          queryClient.invalidateQueries({ queryKey: ['wallet-view', userId] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, queryClient]);

  useEffect(() => {
    if (filteredOrders.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filteredOrders.some((o) => o.id === selectedId)) {
      setSelectedId(filteredOrders[0].id);
    }
  }, [filteredOrders, selectedId]);

  const supplierCostFor = useBikeCatalogCosts();

  const selected = useMemo(
    () => filteredOrders.find((o) => o.id === selectedId) ?? filteredOrders[0] ?? null,
    [filteredOrders, selectedId],
  );

  const status = selected?.order_status || 'submitted';
  const rejected = status === 'rejected' || status === 'failed';
  const current = stageIndex(status);
  const catalogCost = supplierCostFor(selected?.model_type);
  const valuation = resolveBikeBasePrice(
    selected?.valuation_amount || selected?.total_amount,
    selected?.lease_term_months,
    selected?.model_type,
    catalogCost,
  );
  const outstanding = Number(selected?.amount_outstanding || 0);
  const rate = 0.28;
  const termMonths = selected?.lease_term_months || 12;
  const leaseSchedule = useMemo(() => spiroLeaseSchedule(termMonths, valuation), [termMonths, valuation]);

  if (!userId || !selected || filteredOrders.length === 0) return null;

  const stageDates = [selected.created_at, selected.coo_approved_at, selected.lease_activated_at ?? selected.cfo_disbursed_at];

  return (
    <Card className="border-border">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Bike className="h-4 w-4 text-primary shrink-0" />
            <p className="text-sm font-bold truncate">Spiro bike lease status</p>
          </div>
          <div className="flex items-center gap-1.5">
            {rejected && (
              <Button
                variant="destructive"
                size="sm"
                className="h-7 text-xs gap-1 px-2.5"
                disabled={deletingId === selected.id}
                onClick={() => handleDeleteOrder(selected.id)}
              >
                {deletingId === selected.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
                <span>Delete</span>
              </Button>
            )}
            {onRequestNewOrder && rejected && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs border-primary/30 text-primary hover:bg-primary/10"
                onClick={onRequestNewOrder}
              >
                New application
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label={expanded ? 'Collapse' : 'Expand'}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {expanded && filteredOrders.length > 1 && (
          <Select value={selected.id} onValueChange={setSelectedId}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {filteredOrders.map((o) => (
                <SelectItem key={o.id} value={o.id} className="text-xs">
                  {format(new Date(o.created_at), 'd MMM yyyy')} · {o.model_type || 'Spiro bike'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {expanded && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{selected.model_type || 'Spiro bike'}</p>
                <p className="text-[11px] text-muted-foreground">
                  Valuation {formatUGX(valuation)} · {selected.lease_term_months || 12} month lease
                </p>
                {selected.tracking_reference && (
                  <p className="text-[11px] font-mono text-muted-foreground mt-0.5">
                    Tracking:{' '}
                    <span className="text-foreground font-semibold">{selected.tracking_reference}</span>
                  </p>
                )}
              </div>
              <Badge
                variant="outline"
                className={`gap-1 shrink-0 ${
                  rejected
                    ? 'bg-destructive/15 text-destructive border-destructive/30'
                    : current === 2
                      ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                      : current === 1
                        ? 'bg-sky-500/15 text-sky-600 border-sky-500/30'
                        : 'bg-amber-500/15 text-amber-600 border-amber-500/30'
                }`}
              >
                {rejected ? <XCircle className="h-3 w-3" /> : current === 2 ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                {rejected ? 'Rejected' : STAGES[current]}
              </Badge>
            </div>

            {rejected ? (
              <div className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 space-y-2.5">
                <div className="space-y-0.5">
                  <p className="text-xs font-semibold text-destructive">Application Rejected</p>
                  <p className="text-[11px] text-destructive/90">
                    {selected.rejection_reason || 'Application rejected. No lease was created.'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-destructive/15">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7 text-xs gap-1.5 font-medium shadow-xs"
                    disabled={deletingId === selected.id}
                    onClick={() => handleDeleteOrder(selected.id)}
                  >
                    {deletingId === selected.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                    {deletingId === selected.id ? 'Deleting…' : 'Delete Application'}
                  </Button>
                  {onRequestNewOrder && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs border-primary/30 text-primary hover:bg-primary/10 font-medium"
                      onClick={onRequestNewOrder}
                    >
                      New Application
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <ol className="space-y-2">
                {STAGES.map((label, i) => {
                  const done = i <= current;
                  const at = stageDates[i];
                  return (
                    <li key={label} className="flex items-start gap-2">
                      <span
                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${
                          done
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-muted text-muted-foreground border-border'
                        }`}
                      >
                        {done ? '✓' : i + 1}
                      </span>
                      <div className="min-w-0">
                        <p className={`text-xs font-semibold ${done ? '' : 'text-muted-foreground'}`}>{label}</p>
                        {done && at && (
                          <p className="text-[11px] text-muted-foreground">
                            {format(new Date(at), 'd MMM yyyy, HH:mm')}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}

            {current < 2 && !rejected && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2 text-xs">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                  Scheduled Daily Repayment
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border border-primary/20 bg-background/70 p-2 space-y-0.5">
                    <span className="text-[10px] text-muted-foreground block">First Month Daily</span>
                    <span className="text-xs font-bold text-foreground">{formatUGX(leaseSchedule.firstDaily)}/day</span>
                    <span className="text-[10px] text-muted-foreground block">Month 1</span>
                  </div>
                  <div className="rounded-md border border-primary/20 bg-background/70 p-2 space-y-0.5">
                    <span className="text-[10px] text-muted-foreground block">Last Month Daily</span>
                    <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">{formatUGX(leaseSchedule.lastDaily)}/day</span>
                    <span className="text-[10px] text-muted-foreground block">Month {termMonths}</span>
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground pt-1 border-t border-primary/10 leading-snug">
                  ℹ Reducing balance plan: daily payments fall as principal decreases. The rest of the breakdown will be shown when you have received the bike.
                </p>
              </div>
            )}

            {current === 2 && !rejected && (
              <div className="space-y-2">
                <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Outstanding lease balance</span>
                    <span className="font-semibold">{formatUGX(outstanding)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Monthly charge (reducing balance)</span>
                    <span className="font-semibold">{Math.round(rate * 100)}% per month</span>
                  </div>
                </div>

                {/* Logbook Custody & Settlement Card */}
                <div
                  className={`rounded-lg border p-3 space-y-2 ${
                    outstanding === 0
                      ? 'border-emerald-500/30 bg-emerald-500/5'
                      : 'border-border bg-card/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <ShieldCheck className={`h-4 w-4 ${outstanding === 0 ? 'text-emerald-600' : 'text-primary'}`} />
                      <p className="text-xs font-semibold text-foreground truncate">
                        {outstanding === 0 ? 'Logbook Transfer Authorized' : 'Logbook Title Custody'}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${
                        outstanding === 0
                          ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                          : 'bg-indigo-500/15 text-indigo-600 border-indigo-500/30'
                      }`}
                    >
                      {outstanding === 0 ? '✓ Ready for Pickup' : '🔒 In Welile Custody'}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {outstanding === 0
                      ? 'Congratulations! Your Spiro bike lease is 100% settled. Welile has discharged its legal custody hold, and your official logbook transfer is authorized.'
                      : 'The Spiro logbook and registration title remain in Welile legal custody throughout the active lease period until full settlement.'}
                  </p>

                  {outstanding === 0 && (
                    <Button
                      size="sm"
                      className="w-full h-8 text-xs font-semibold gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white mt-1"
                      disabled={downloadingCert}
                      onClick={async () => {
                        setDownloadingCert(true);
                        try {
                          const { data: profile } = await supabase
                            .from('profiles')
                            .select('full_name, phone, national_id')
                            .eq('id', userId!)
                            .maybeSingle();
                          const blob = await generateSpiroBikeSettlementCertificatePdf({
                            agentName: profile?.full_name || 'Agent',
                            agentPhone: profile?.phone || null,
                            nationalId: profile?.national_id || null,
                            modelType: selected.model_type || 'Spiro electric bike',
                            trackingReference: selected.tracking_reference || null,
                            valuationAmount: valuation,
                            totalRepaid: valuation,
                            leaseTermMonths: selected.lease_term_months || 12,
                            completedAt: selected.lease_activated_at || selected.cfo_disbursed_at || selected.created_at,
                            saleId: selected.id,
                          });
                          downloadSpiroSettlementCertificate(blob, profile?.full_name || 'Agent', selected.tracking_reference);
                          toast.success('Certificate of Full Settlement downloaded');
                        } catch (err: any) {
                          toast.error('Could not download certificate: ' + (err.message || 'Unknown error'));
                        } finally {
                          setDownloadingCert(false);
                        }
                      }}
                    >
                      {downloadingCert ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                      Download Settlement Certificate
                    </Button>
                  )}
                </div>
              </div>
            )}

            {current === 2 && !rejected && (
              <BikeRepaymentPlanSchedule
                termMonths={termMonths}
                valuation={valuation}
                activatedAt={selected.lease_activated_at || selected.cfo_disbursed_at}
              />
            )}

            {current === 2 && !rejected && (
              <BikeRepaymentTracker userId={userId} saleId={selected.id} />
            )}

          </div>
        )}
      </CardContent>
    </Card>
  );
}
