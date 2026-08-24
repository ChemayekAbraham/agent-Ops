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
import { Smartphone, Clock, Loader2, CheckCircle2, XCircle, Download, Mail, Copy, Trash2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  downloadSmartphoneOrderReceipt,
  shareSmartphoneOrderReceipt,
} from '@/lib/smartphoneOrderReceiptPdf';
import { SMARTPHONE_RECOVERY_RATE } from './SmartphoneOrderDialog';


const db = supabase as any;


type OrderStatus = 'submitted' | 'pending_approval' | 'approved' | 'rejected' | 'processing' | 'completed' | 'failed';

interface SmartphoneOrder {
  id: string;
  unit_price: number;
  amount_outstanding: number;
  order_status: OrderStatus;
  created_at: string;
  client_name: string | null;
  client_phone: string | null;
  tracking_reference: string | null;
}

const STATUS_META: Record<OrderStatus, { label: string; icon: typeof Clock; className: string }> = {
  submitted: { label: 'Submitted', icon: Clock, className: 'bg-muted text-muted-foreground border-border' },
  pending_approval: { label: 'Pending approval', icon: Clock, className: 'bg-amber-500/15 text-amber-600 border-amber-500/30' },
  approved: { label: 'Approved', icon: CheckCircle2, className: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' },
  rejected: { label: 'Rejected', icon: XCircle, className: 'bg-destructive/15 text-destructive border-destructive/30' },
  processing: { label: 'Processing', icon: Loader2, className: 'bg-amber-500/15 text-amber-600 border-amber-500/30' },
  completed: { label: 'Completed', icon: CheckCircle2, className: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30' },
  failed: { label: 'Failed', icon: XCircle, className: 'bg-destructive/15 text-destructive border-destructive/30' },
};

const KNOWN_STATUSES: OrderStatus[] = ['submitted', 'pending_approval', 'approved', 'rejected', 'processing', 'completed', 'failed'];

/** Payment projection is only revealed once an executive approves the order. */
const APPROVED_STATUSES: OrderStatus[] = ['approved', 'processing', 'completed'];


function normalizeStatus(value: unknown): OrderStatus {
  return KNOWN_STATUSES.includes(value as OrderStatus) ? (value as OrderStatus) : 'submitted';
}


interface Props {
  userId?: string;
  /** merchandise_sales.item_name to filter on. Defaults to 'Welile Smartphone'. */
  itemName?: string;
  /** Panel heading. Defaults to 'Smartphone order status'. */
  title?: string;
}

export default function SmartphoneOrderStatus({
  userId,
  itemName = 'Welile Smartphone',
  title = 'Smartphone order status',
}: Props) {
  const queryClient = useQueryClient();
  const [emailingId, setEmailingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<SmartphoneOrder | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const { data: orders = [] } = useQuery<SmartphoneOrder[]>({
    queryKey: ['my-smartphone-orders', userId, itemName],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_sales')
        .select('id, unit_price, amount_outstanding, order_status, created_at, client_name, client_phone, tracking_reference')
        .eq('customer_id', userId)
        .eq('item_name', itemName)
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

  const handleCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      const { error } = await db.rpc('agent_cancel_merchandise_order', {
        p_sale_id: cancelTarget.id,
        p_reason: 'Cancelled by the agent before approval to place a new order',
      });
      if (error) throw error;
      toast.success('Order cancelled — you can place a new one');
      setCancelTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['my-smartphone-orders', userId, itemName] }),
        queryClient.invalidateQueries({ queryKey: ['merchandise-order-lock', userId, itemName] }),
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
    amount: Number(o.unit_price),
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
            amount: Number(o.unit_price),
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
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-primary" />
          <p className="text-sm font-bold">{title}</p>
        </div>
        {orders.length > 1 && (
          <Select value={selected.id} onValueChange={setSelectedId}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Select an order" />
            </SelectTrigger>
            <SelectContent>
              {orders.map((o) => (
                <SelectItem key={o.id} value={o.id} className="text-xs">
                  {format(new Date(o.created_at), 'd MMM yyyy, HH:mm')} · {formatUGX(Number(o.unit_price))} ·{' '}
                  {STATUS_META[normalizeStatus(o.order_status)].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
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
                    <p className="text-sm font-semibold">{formatUGX(Number(o.unit_price))}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Ordered {format(new Date(o.created_at), 'd MMM yyyy, HH:mm')}
                      {Number(o.amount_outstanding) > 0
                        ? ` · ${formatUGX(Number(o.amount_outstanding))} to recover`
                        : ' · fully recovered'}
                    </p>
                    {APPROVED_STATUSES.includes(status) && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Payment projection:{' '}
                        <span className="text-foreground font-semibold">
                          {formatUGX(Math.round(Number(o.unit_price) * SMARTPHONE_RECOVERY_RATE))}
                        </span>
                      </p>
                    )}
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
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 gap-1.5 text-xs"
                    onClick={() => handleReceipt(o)}
                  >
                    <Download className="h-3.5 w-3.5" /> Download
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 gap-1.5 text-xs"
                    disabled={emailingId === o.id}
                    onClick={() => handleEmail(o)}
                  >
                    {emailingId === o.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Mail className="h-3.5 w-3.5" />} Email
                  </Button>
                  {o.tracking_reference && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 flex-1 gap-1.5 text-xs"
                      onClick={() => handleCopyTracking(o)}
                    >
                      {copiedId === o.id ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" /> Copy tracking
                        </>
                      )}
                    </Button>
                  )}
                </div>
                {cancellable && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-full gap-1.5 text-xs text-destructive border-destructive/40 hover:bg-destructive/10"
                    onClick={() => setCancelTarget(o)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Cancel this application
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        <AlertDialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel this application?</AlertDialogTitle>
              <AlertDialogDescription className="text-xs">
                {cancelTarget
                  ? `Your ${formatUGX(Number(cancelTarget.unit_price))} ${itemName} application from ${format(new Date(cancelTarget.created_at), 'd MMM yyyy, HH:mm')} will be withdrawn before approval, and you can place a new order right away. Applications already in repayment cannot be cancelled.`
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
                {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Cancel application'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

      </CardContent>
    </Card>
  );
}