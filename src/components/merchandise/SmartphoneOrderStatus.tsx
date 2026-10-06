import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useEffect, useMemo, useState } from 'react';
import { Smartphone, Clock, Loader2, CheckCircle2, XCircle, Download, Mail, Copy, Trash2, MoreVertical, ChevronDown, ChevronUp } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  downloadSmartphoneOrderReceipt,
  shareSmartphoneOrderReceipt,
} from '@/lib/smartphoneOrderReceiptPdf';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import DeviceAccessDialog from '@/components/merchandise/DeviceAccessDialog';
import { downPaymentCopy } from '@/lib/moBanjaIphone';


const db = supabase as any;


type OrderStatus = 'submitted' | 'pending_approval' | 'coo_approved' | 'approved' | 'rejected' | 'processing' | 'completed' | 'failed';

interface SmartphoneOrder {
  id: string;
  item_name?: string | null;
  unit_price: number;
  amount_outstanding: number;
  order_status: OrderStatus;
  created_at: string;
  client_name: string | null;
  client_phone: string | null;
  tracking_reference: string | null;
  access_accepted_at: string | null;
  rejection_reason: string | null;
  rejected_at: string | null;
  total_repayable?: number | null;
  access_daily_amount?: number | null;
  access_repayment_days?: number | null;
  advance_period_months?: number | null;
  repayment_starts_on?: string | null;
}

interface ScheduleRow {
  month_index: number;
  period_start: string;
  period_end: string;
  total_due: number | null;
  daily_deduction: number | null;
}

const STATUS_META: Record<OrderStatus, { label: string; icon: typeof Clock; className: string }> = {
  submitted: { label: 'Submitted', icon: Clock, className: 'bg-muted text-muted-foreground border-border' },
  pending_approval: { label: 'Pending approval', icon: Clock, className: 'bg-amber-500/15 text-amber-600 border-amber-500/30' },
  coo_approved: { label: 'Approved — awaiting disbursement', icon: Clock, className: 'bg-sky-500/15 text-sky-600 border-sky-500/30' },
  approved: { label: 'Approved', icon: CheckCircle2, className: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' },
  rejected: { label: 'Rejected', icon: XCircle, className: 'bg-destructive/15 text-destructive border-destructive/30' },
  processing: { label: 'Processing', icon: Loader2, className: 'bg-amber-500/15 text-amber-600 border-amber-500/30' },
  completed: { label: 'Completed', icon: CheckCircle2, className: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' },
  failed: { label: 'Failed', icon: XCircle, className: 'bg-destructive/15 text-destructive border-destructive/30' },
};

const KNOWN_STATUSES: OrderStatus[] = ['submitted', 'pending_approval', 'coo_approved', 'approved', 'rejected', 'processing', 'completed', 'failed'];

/** Access amount is only revealed once an executive approves the order. */
const APPROVED_STATUSES: OrderStatus[] = ['approved', 'processing', 'completed'];

/** Only rejected or failed applications can be removed by the agent; pending orders cannot be deleted. */
const CANCELLABLE_STATUSES: OrderStatus[] = ['rejected', 'failed'];


function normalizeStatus(value: unknown): OrderStatus {
  return KNOWN_STATUSES.includes(value as OrderStatus) ? (value as OrderStatus) : 'submitted';
}


/**
 * Amount owed to Welile: the reducing-balance total once the application has
 * been priced, otherwise the device amount on its own.
 */
const accessFee = (o: { unit_price: number; total_repayable?: number | null }) =>
  Math.round(
    Number(o.total_repayable || 0) > 0 ? Number(o.total_repayable) : Number(o.unit_price || 0),
  );


interface Props {
  userId?: string;
  /** merchandise_sales.item_name to filter on. Defaults to 'Welile Smartphone'. */
  itemName?: string;
  /** Panel heading. Defaults to 'Smartphone order status'. */
  title?: string;
  /** Called when the user chooses to place a new order from inside the status card. */
  onRequestNewOrder?: () => void;
}

export default function SmartphoneOrderStatus({
  userId,
  itemName = 'Welile Smartphone',
  title = 'Smartphone order status',
  onRequestNewOrder,
}: Props) {
  const queryClient = useQueryClient();
  const [emailingId, setEmailingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<SmartphoneOrder | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [accessOrderId, setAccessOrderId] = useState<string | null>(null);
  const isSmartphonePanel = itemName === 'Welile Smartphone';

  // Ops-issued devices are recorded with the catalog model name (e.g. "Samsung A07"),
  // so the agent's smartphone panel must match those names too.
  const { data: catalogNames = [] } = useQuery<string[]>({
    queryKey: ['smartphone-catalog-names'],
    enabled: isSmartphonePanel,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await db
        .from('smartphone_catalog')
        .select('brand, model_name');
      if (error) throw error;
      return ((data || []) as { brand: string; model_name: string | null }[])
        .map((c) => `${c.brand} ${c.model_name ?? ''}`.trim())
        .filter(Boolean);
    },
  });

  const itemNames = useMemo(
    () => Array.from(new Set([itemName, ...(isSmartphonePanel ? catalogNames : [])])),
    [itemName, isSmartphonePanel, catalogNames],
  );

  const { data: orders = [] } = useQuery<SmartphoneOrder[]>({
    queryKey: ['my-smartphone-orders', userId, itemName, itemNames.join('|')],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_sales')
        .select('id, item_name, unit_price, amount_outstanding, order_status, created_at, client_name, client_phone, tracking_reference, access_accepted_at, rejection_reason, rejected_at, total_repayable, access_daily_amount, access_repayment_days, advance_period_months, repayment_starts_on')
        .eq('customer_id', userId)
        .in('item_name', itemNames)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const { data: profile } = useQuery<{ email: string | null; full_name: string | null } | null>({
    queryKey: ['my-profile-email', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await db
        .from('profiles')
        .select('email, full_name')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  /**
   * Realtime: the COO approval and the CFO disbursement both update this
   * agent's `merchandise_sales` row. Refresh the status card AND the wallet
   * caches so the float credit shows up without a manual reload.
   */
  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`my-smartphone-orders-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'merchandise_sales', filter: `customer_id=eq.${userId}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ['my-smartphone-orders'] });
          queryClient.invalidateQueries({ queryKey: ['wallet-view', userId] });

          queryClient.invalidateQueries({ queryKey: ['agent-commission-net', userId] });
          queryClient.invalidateQueries({ queryKey: ['merchandise-recovery-plan', userId] });
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [userId, queryClient]);

  /** Keep the dropdown pointed at a still-existing order (newest by default). */
  useEffect(() => {
    if (orders.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !orders.some((o) => o.id === selectedId)) {
      setSelectedId(orders[0].id);
    }
  }, [orders, selectedId]);

  const selected = useMemo(
    () => orders.find((o) => o.id === selectedId) ?? orders[0] ?? null,
    [orders, selectedId],
  );

  // Reducing-balance repayment schedule for the order on screen.
  const { data: scheduleRows = [] } = useQuery<ScheduleRow[]>({
    queryKey: ['smartphone-repayment-schedule', selected?.id],
    enabled: !!selected?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await db
        .from('smartphone_repayment_schedules')
        .select('month_index, period_start, period_end, total_due, daily_deduction')
        .eq('sale_id', selected!.id)
        .order('month_index', { ascending: true });
      if (error) throw error;
      return (data || []) as ScheduleRow[];
    },
  });

  const currentScheduleRow = useMemo(() => {
    if (!scheduleRows.length) return null;
    const today = new Date().toISOString().slice(0, 10);
    return (
      scheduleRows.find((r) => r.period_start <= today && r.period_end >= today) ??
      (today < scheduleRows[0].period_start ? scheduleRows[0] : scheduleRows[scheduleRows.length - 1])
    );
  }, [scheduleRows]);


  const handleCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      const { error } = await db.rpc('agent_cancel_merchandise_order', {
        p_sale_id: cancelTarget.id,
        p_reason: 'Order deleted by the agent (pending or rejected) to place a new one',
      });
      if (error) throw error;
      toast.success('Order deleted — you can place a new one');
      setCancelTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['my-smartphone-orders'] }),
        queryClient.invalidateQueries({ queryKey: ['my-bike-lease-orders'] }),
        queryClient.invalidateQueries({ queryKey: ['merchandise-order-lock'] }),
        queryClient.invalidateQueries({ queryKey: ['merchandise-recovery-plan'] }),
        queryClient.invalidateQueries({ queryKey: ['my-merchandise-plans'] }),
      ]);
    } catch (e: any) {
      console.error('[SmartphoneOrderStatus] cancel error', e);
      toast.error(e?.message || 'Could not cancel this order');
    } finally {
      setCancelling(false);
    }
  };

  if (!userId || orders.length === 0 || !selected) return null;


  const isRealEmail = (email?: string | null) =>
    !!email && !email.endsWith('@welile.user') && !email.endsWith('@noapp.welile.user');

  const getReceipt = (o: SmartphoneOrder) => ({
    orderId: o.id,
    amount: accessFee(o),
    outstanding: Number(o.amount_outstanding),
    status: normalizeStatus(o.order_status),
    orderedAt: new Date(o.created_at),
    customerName: o.client_name,
    customerPhone: o.client_phone,
    itemLabel: itemName,
    trackingReference: o.tracking_reference,
  });

  const handleReceipt = async (o: SmartphoneOrder) => {
    try {
      const data = getReceipt(o);
      const shared = await shareSmartphoneOrderReceipt(data);
      if (!shared) {
        await downloadSmartphoneOrderReceipt(data);
        toast.success('Receipt downloaded');
      }
    } catch (e: any) {
      console.error('[SmartphoneOrderStatus] receipt error', e);
      toast.error('Could not generate receipt');
    }
  };

  const handleEmail = async (o: SmartphoneOrder) => {
    const email = profile?.email ?? null;
    if (!isRealEmail(email)) {
      toast.error('Add a valid email to your profile to receive receipts by email');
      return;
    }
    setEmailingId(o.id);
    try {
      const status = normalizeStatus(o.order_status);
      const fmtDate = (d: Date) =>
        d.toLocaleString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const { error } = await supabase.functions.invoke('send-transactional-email', {
        body: {
          templateName: 'smartphone-order-receipt',
          recipientEmail: email,
          idempotencyKey: `smartphone-order-receipt-${o.id}-${status}`,
          templateData: {
            recipient_name: profile?.full_name || o.client_name || 'there',
            amount: accessFee(o),
            outstanding: Number(o.amount_outstanding),
            currency: 'UGX',
            order_status: status,
            order_reference: o.id,
            ordered_at: fmtDate(new Date(o.created_at)),
            generated_at: fmtDate(new Date()),
            item_label: itemName,
            tracking_reference: o.tracking_reference ?? '',
          },
        },
      });
      if (error) throw error;
      toast.success(`Receipt emailed to ${email}`);
    } catch (e: any) {
      console.error('[SmartphoneOrderStatus] email error', e);
      toast.error('Could not email receipt');
    } finally {
      setEmailingId(null);
    }
  };

  const handleCopyTracking = async (o: SmartphoneOrder) => {
    if (!o.tracking_reference) return;
    try {
      await navigator.clipboard.writeText(o.tracking_reference);
      setCopiedId(o.id);
      toast.success('Tracking reference copied');
      setTimeout(() => setCopiedId((current) => (current === o.id ? null : current)), 2000);
    } catch {
      toast.error('Could not copy tracking reference');
    }
  };

  return (
    <Card className="border-border">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" />
            <p className="text-sm font-bold">{title}</p>
          </div>
          <div className="flex items-center gap-1">
            {onRequestNewOrder && selected && ['rejected', 'failed'].includes(normalizeStatus(selected.order_status)) && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1 border-primary/30 text-primary hover:bg-primary/10"
                onClick={onRequestNewOrder}
              >
                New order
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
        {expanded && orders.length > 1 && (
          <Select value={selected.id} onValueChange={setSelectedId}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Select an order" />
            </SelectTrigger>
            <SelectContent>
              {orders.map((o) => (
                <SelectItem key={o.id} value={o.id} className="text-xs">
                  {format(new Date(o.created_at), 'd MMM yyyy, HH:mm')} · {formatUGX(accessFee(o))} ·{' '}
                  {STATUS_META[normalizeStatus(o.order_status)].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {expanded && (
        <div className="space-y-2">
          {[selected].map((o) => {
            const status = normalizeStatus(o.order_status);
            const meta = STATUS_META[status];
            const Icon = meta.icon;
            const cancellable = CANCELLABLE_STATUSES.includes(status);
            return (
              <div
                key={o.id}
                className="rounded-xl border border-border bg-card px-3 py-2 space-y-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Down payment funded by Welile
                    </p>
                    <p className="text-sm font-semibold">{formatUGX(accessFee(o))}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Ordered {format(new Date(o.created_at), 'd MMM yyyy, HH:mm')}
                      {Number(o.amount_outstanding) > 0
                        ? ` · ${formatUGX(Number(o.amount_outstanding))} to recover`
                        : ' · fully recovered'}
                    </p>

                    {o.tracking_reference && (
                      <p className="text-[11px] font-mono text-muted-foreground mt-0.5">
                        Tracking: <span className="text-foreground font-semibold">{o.tracking_reference}</span>
                      </p>
                    )}

                  </div>
                  <Badge variant="outline" className={`gap-1 shrink-0 ${meta.className}`}>
                    <Icon className={`h-3 w-3 ${status === 'processing' ? 'animate-spin' : ''}`} />
                    {meta.label}
                  </Badge>
                </div>
                {scheduleRows.length > 0 && (
                  <div className="rounded-lg border border-border bg-muted/30 px-2.5 py-2 space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-[11px] font-semibold">Your daily repayment</p>
                      {currentScheduleRow && (
                        <p className="text-sm font-bold tabular-nums text-green-600">
                          {formatUGX(Number(currentScheduleRow.daily_deduction || 0))}/day
                        </p>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      The amount reduces every month as your balance comes down.
                    </p>
                    <div className="rounded-md border border-border bg-background/60 overflow-hidden">
                      <div className="grid grid-cols-3 gap-1 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                        <span>Month</span>
                        <span className="text-right">Amount</span>
                        <span className="text-right">Per day</span>
                      </div>
                      {scheduleRows.map((r) => (
                        <div
                          key={r.month_index}
                          className={`grid grid-cols-3 gap-1 border-t border-border px-2 py-1 text-[11px] tabular-nums ${
                            currentScheduleRow?.month_index === r.month_index ? 'bg-primary/5 font-medium' : ''
                          }`}
                        >
                          <span className="text-muted-foreground">
                            {format(new Date(r.period_start), 'MMM yyyy')}
                          </span>
                          <span className="text-right">{formatUGX(Number(r.total_due || 0))}</span>
                          <span className="text-right">{formatUGX(Number(r.daily_deduction || 0))}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {(() => {
                  const copy = downPaymentCopy(null, o.item_name);
                  return (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-2 space-y-1">
                      <p className="text-[11px] font-semibold">{copy.title}</p>
                      <p className="text-[11px] text-muted-foreground">{copy.amountNote}</p>
                      <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                        {copy.twoLegs.map((line) => (
                          <li key={line}>• {line}</li>
                        ))}
                      </ul>
                      {copy.lockNotice && (
                        <p className="text-[11px] text-muted-foreground">{copy.lockNotice}</p>
                      )}
                      <p className="text-[11px] text-muted-foreground">
                        Welile pays the down payment straight to the supplier. The daily repayment stays yours —
                        it is deducted from your wallet or commission.
                      </p>
                    </div>
                  );
                })()}
                {status === 'rejected' && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2">
                    <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-destructive">Why it was rejected</p>
                      <p className="text-xs text-foreground">
                        {o.rejection_reason?.trim() || 'No reason was recorded. Please contact support or place a new order.'}
                      </p>
                      {o.rejected_at && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          Rejected on {format(new Date(o.rejected_at), 'd MMM yyyy, HH:mm')}
                        </p>
                      )}
                    </div>
                  </div>
                )}
                {status === 'approved' && !o.access_accepted_at && (
                  <Button
                    size="sm"
                    className="h-8 w-full gap-1.5 text-xs"
                    onClick={() => setAccessOrderId(o.id)}
                  >
                    <Smartphone className="h-3.5 w-3.5" /> Proceed to access device
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-full gap-1.5 text-xs"
                    >
                      <MoreVertical className="h-3.5 w-3.5" /> Actions
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onClick={() => handleReceipt(o)}>
                      <Download className="h-3.5 w-3.5 mr-2" /> Download receipt
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={emailingId === o.id}
                      onClick={() => handleEmail(o)}
                    >
                      {emailingId === o.id ? (
                        <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                      ) : (
                        <Mail className="h-3.5 w-3.5 mr-2" />
                      )}
                      Email receipt
                    </DropdownMenuItem>
                    {o.tracking_reference && (
                      <DropdownMenuItem onClick={() => handleCopyTracking(o)}>
                        {copiedId === o.id ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5 mr-2 text-emerald-600" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5 mr-2" /> Copy tracking
                          </>
                        )}
                      </DropdownMenuItem>
                    )}
                    {cancellable && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive focus:bg-destructive/10"
                          onClick={() => setCancelTarget(o)}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete order
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
        )}
        <DeviceAccessDialog
          userId={userId}
          saleId={accessOrderId}
          open={!!accessOrderId}
          onOpenChange={(v) => !v && setAccessOrderId(null)}
        />

        <AlertDialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this order?</AlertDialogTitle>
              <AlertDialogDescription className="text-xs">
                {cancelTarget
                  ? `Your ${formatUGX(accessFee(cancelTarget))} ${itemName} order from ${format(new Date(cancelTarget.created_at), 'd MMM yyyy, HH:mm')} will be removed and you can place a new one right away. Orders already in repayment cannot be deleted.`
                  : null}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={cancelling}>Keep it</AlertDialogCancel>
              <AlertDialogAction
                disabled={cancelling}
                onClick={(e) => {
                  e.preventDefault();
                  handleCancel();
                }}
              >
                {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Delete order'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

      </CardContent>
    </Card>
  );
}