import { useState } from 'react';
import { Loader2, Wallet } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { OrderStatusPair } from '@/components/food/FoodStatusBadges';
import {
  useFoodOrderEvents, useFoodExceptions, useRaiseFoodException, formatUgx,
  useConfirmFoodReceipt, usePayFoodOrder,
  FOOD_FULFILMENT_LABEL, FOOD_EXCEPTION_KINDS, FOOD_EXCEPTION_KIND_LABEL,
  FOOD_MAX_EXCEPTION_NOTE,
  type FoodOrderDetail, type FoodFulfilmentStatus, type FoodExceptionKind,
} from '@/hooks/useFoodService';

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

const EVENT_LABEL: Record<string, string> = {
  placed: 'Order placed',
  cancelled: 'Withdrawn',
  problem_reported: 'Problem reported',
};

export default function FoodOrderDetailDialog({
  order, open, onOpenChange, allowProblemReport = false,
}: {
  order: FoodOrderDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the employee's own view: may report a problem with this order */
  allowProblemReport?: boolean;
}) {
  const { data: events, isLoading } = useFoodOrderEvents(order?.id);
  // RLS returns an employee only the reports they raised
  const { data: exceptions } = useFoodExceptions(allowProblemReport && open);
  const raise = useRaiseFoodException();
  const [kind, setKind] = useState<FoodExceptionKind | ''>('');
  const [note, setNote] = useState('');
  const confirmReceipt = useConfirmFoodReceipt();
  const pay = usePayFoodOrder();
  const [confirmPay, setConfirmPay] = useState(false);

  if (!order) return null;

  const reports = (exceptions ?? []).filter((e) => e.order_id === order.id);
  const hasOpenReport = reports.some((e) => !e.resolved_at);
  const noteOk = note.trim().length > 0 && note.trim().length <= FOOD_MAX_EXCEPTION_NOTE;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">{order.order_reference}</DialogTitle>
          <DialogDescription>
            Placed {when(order.placed_at)}
          </DialogDescription>
        </DialogHeader>

        <OrderStatusPair
          payment={order.payment_status}
          fulfilment={order.fulfilment_status}
          mode={order.payment_mode}
        />

        <Separator />

        <ul className="space-y-2">
          {(order.items ?? []).map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                {/* snapshots: a later menu edit never restates a placed order */}
                <p className="font-medium">{item.meal_name}</p>
                <p className="text-xs text-muted-foreground">
                  {item.quantity} &times; {formatUgx(item.unit_price_ugx)}
                </p>
              </div>
              <span className="shrink-0 font-semibold tabular-nums">
                {formatUgx(item.line_total_ugx)}
              </span>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between border-t border-border/70 pt-3">
          <span className="text-sm text-muted-foreground">Total</span>
          <span className="text-base font-semibold">{formatUgx(order.total_ugx)}</span>
        </div>

        {order.special_instructions && (
          <p className="rounded-lg bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Your note: </span>
            {order.special_instructions}
          </p>
        )}

        {allowProblemReport && order.fulfilment_status !== 'cancelled' && (() => {
          const handedOver = ['ready', 'collected', 'delivered'].includes(order.fulfilment_status);
          const received = !!order.received_at;
          const canPay = received && order.payment_status === 'pending_payment' && !hasOpenReport;
          if (order.payment_status === 'paid') return null;
          return (
            <section aria-label="Pay for this order" className="space-y-2 rounded-lg border border-border/70 p-3">
              {!received ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Once you have your food, confirm it to pay from your wallet.
                  </p>
                  <Button
                    size="sm" className="w-full"
                    disabled={!handedOver || confirmReceipt.isPending}
                    onClick={() => confirmReceipt.mutate({ orderId: order.id })}
                  >
                    {confirmReceipt.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" aria-hidden="true" />}
                    I received my order
                  </Button>
                </>
              ) : canPay ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    {order.payee_name ? `You are paying ${order.payee_name}. ` : ''}
                    {formatUgx(order.total_ugx)} will be taken from your wallet.
                  </p>
                  <Button
                    size="sm" className="w-full"
                    disabled={pay.isPending}
                    onClick={() => setConfirmPay(true)}
                  >
                    {pay.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" aria-hidden="true" />}
                    <Wallet className="mr-2 h-4 w-4" aria-hidden="true" />
                    Pay by wallet
                  </Button>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {hasOpenReport ? 'Payment opens once your reported problem is resolved.' : 'This order cannot be paid right now.'}
                </p>
              )}
            </section>
          );
        })()}

        <AlertDialog open={confirmPay} onOpenChange={setConfirmPay}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Pay {formatUgx(order.total_ugx)} from your wallet?</AlertDialogTitle>
              <AlertDialogDescription>
                For order {order.order_reference}
                {order.payee_name ? `, paid to ${order.payee_name}` : ''}. If your wallet is short, nothing is charged.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => pay.mutate({ orderId: order.id })}>Pay now</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>


        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Progress
          </h3>
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Loading…
            </div>
          ) : (events ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
          ) : (
            <ol className="space-y-3 border-l border-border/70 pl-4">
              {(events ?? []).map((e) => (
                <li key={e.id} className="relative">
                  <span
                    className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary"
                    aria-hidden="true"
                  />
                  <p className="text-sm font-medium">
                    {e.to_status
                      ? FOOD_FULFILMENT_LABEL[e.to_status as FoodFulfilmentStatus] ?? e.to_status
                      : EVENT_LABEL[e.event_type] ?? e.event_type}
                  </p>
                  <p className="text-xs text-muted-foreground">{when(e.created_at)}</p>
                  {e.note && (
                    <p className="mt-0.5 text-xs italic text-muted-foreground">
                      {e.event_type === 'problem_reported'
                        ? FOOD_EXCEPTION_KIND_LABEL[e.note as FoodExceptionKind] ?? e.note
                        : e.note}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>

        {allowProblemReport && (
          <section aria-label="Report a problem" className="space-y-2 border-t border-border/70 pt-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Problem with this order?
            </h3>

            {reports.map((r) => (
              <div key={r.id} className="rounded-lg bg-muted/60 p-3 text-xs leading-relaxed">
                <p className="font-medium">
                  {FOOD_EXCEPTION_KIND_LABEL[r.kind as FoodExceptionKind] ?? r.kind}
                  {' · '}
                  {r.resolved_at ? 'Resolved' : 'With the Food Coordinator'}
                </p>
                {typeof r.detail?.note === 'string' && (
                  <p className="text-muted-foreground">{r.detail.note}</p>
                )}
                {r.resolved_at && r.resolution_reason && (
                  <p className="mt-1">
                    <span className="font-medium">Outcome: </span>{r.resolution_reason}
                  </p>
                )}
              </div>
            ))}

            {hasOpenReport ? (
              <p className="text-xs text-muted-foreground">
                Your report is with the Food Coordinator.
              </p>
            ) : (
              <>
                <label htmlFor="food-problem-kind" className="sr-only">What went wrong</label>
                <select
                  id="food-problem-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as FoodExceptionKind)}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">What went wrong?</option>
                  {FOOD_EXCEPTION_KINDS.map((k) => (
                    <option key={k} value={k}>{FOOD_EXCEPTION_KIND_LABEL[k]}</option>
                  ))}
                </select>
                <label htmlFor="food-problem-note" className="sr-only">Describe the problem</label>
                <Textarea
                  id="food-problem-note"
                  value={note}
                  maxLength={FOOD_MAX_EXCEPTION_NOTE}
                  rows={2}
                  placeholder="Describe the problem"
                  onChange={(e) => setNote(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!kind || !noteOk || raise.isPending}
                  onClick={() => kind && raise.mutate(
                    { kind, note: note.trim(), orderId: order.id },
                    { onSuccess: () => { setKind(''); setNote(''); } },
                  )}
                >
                  {raise.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" aria-hidden="true" />}
                  Report problem
                </Button>
              </>
            )}
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
