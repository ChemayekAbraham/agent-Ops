import { useState } from 'react';
import { AlertCircle, ChefHat, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { OrderStatusPair } from '@/components/food/FoodStatusBadges';
import {
  useFoodOrders, useFoodPreparationList, useSetFoodFulfilment,
  useFoodCoordinatorOverview, nextFoodStatuses, canStartPreparing,
  FOOD_FULFILMENT_LABEL, formatUgx, isSimulatedPayment,
  type FoodFulfilmentStatus, type FoodOrderDetail,
} from '@/hooks/useFoodService';

function when(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function FoodQueuePanel({ canAuthor }: { canAuthor: boolean }) {
  const { data: overview } = useFoodCoordinatorOverview();
  const { data: orders, isLoading, isError, error, refetch } = useFoodOrders();
  const { data: prep, isLoading: prepLoading } = useFoodPreparationList();
  const setFulfilment = useSetFoodFulfilment();
  const [toCancel, setToCancel] = useState<FoodOrderDetail | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  // The rule in force comes from the server. Default to the safe (strict)
  // reading until it has loaded, so we never offer a button that will fail.
  const requiresPayment = overview?.fulfilment_requires_payment ?? true;

  const allowed = (o: FoodOrderDetail, to: FoodFulfilmentStatus): boolean => {
    if (!nextFoodStatuses(o.fulfilment_status).includes(to)) return false;
    if (to !== 'preparing') return true;
    return canStartPreparing(o.fulfilment_status, o.payment_status, {
      requirePayment: requiresPayment,
    });
  };

  const live = (orders ?? []).filter((o) => o.fulfilment_status !== 'cancelled');
  // Payment is disabled, so any "paid" order here carries fixture evidence.
  // Say so plainly rather than let it read as a real settlement.
  const simulated = live.filter(isSimulatedPayment);

  return (
    <div className="space-y-5">
      {simulated.length > 0 && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
          <strong className="font-semibold">
            {simulated.length} order{simulated.length === 1 ? '' : 's'} here carry test
            payment evidence, not a real payment.
          </strong>{' '}
          No wallet was charged and no accounting entry exists for them. They are
          seeded so this queue can be worked while payment is switched off.
        </p>
      )}

      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <ChefHat className="h-4 w-4" aria-hidden="true" />
          Preparation list
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          What the kitchen needs to cook, totalled across every order it may work on.
        </p>

        {prepLoading ? (
          <Skeleton className="h-24 w-full rounded-xl" />
        ) : (prep ?? []).length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            {requiresPayment
              ? 'Nothing to prepare. Orders must be paid before the kitchen can start, and payment is not open yet.'
              : 'Nothing to prepare yet today.'}
          </p>
        ) : (
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70 bg-card">
            {(prep ?? []).map((row) => (
              <li key={row.meal_name} className="flex items-center justify-between gap-3 p-3">
                <span className="min-w-0 truncate text-sm font-medium">{row.meal_name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {row.order_count} order{row.order_count === 1 ? '' : 's'}
                </span>
                <span className="w-10 shrink-0 text-right text-base font-semibold tabular-nums">
                  {row.total_quantity}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Inbox className="h-4 w-4" aria-hidden="true" />
          Incoming orders
        </h2>

        {isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-xl" />
            ))}
          </div>
        )}

        {isError && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" aria-hidden="true" />
            <p className="text-sm font-medium">Orders could not be loaded</p>
            <p className="text-xs text-muted-foreground">
              {(error as Error)?.message ?? 'Please try again.'}
            </p>
            <Button size="sm" variant="outline" onClick={() => refetch()}>Try again</Button>
          </div>
        )}

        {!isLoading && !isError && live.length === 0 && (
          <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            No orders today yet.
          </p>
        )}

        <ul className="space-y-2">
          {live.map((order) => {
            const targets = nextFoodStatuses(order.fulfilment_status);
            return (
              <li key={order.id} className="rounded-xl border border-border/70 bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {order.employee_name ?? 'Employee'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {order.order_reference} &middot; {when(order.placed_at)}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">
                    {formatUgx(order.total_ugx)}
                  </span>
                </div>

                <ul className="mt-2 space-y-0.5">
                  {order.items.map((i) => (
                    <li key={i.id} className="text-xs text-muted-foreground">
                      {i.quantity} &times; {i.meal_name}
                    </li>
                  ))}
                </ul>

                {order.special_instructions && (
                  <p className="mt-2 rounded bg-muted/60 p-2 text-xs italic text-muted-foreground">
                    {order.special_instructions}
                  </p>
                )}

                <OrderStatusPair
                  className="mt-3"
                  payment={order.payment_status}
                  fulfilment={order.fulfilment_status}
                  mode={order.payment_mode}
                />

                {targets.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {targets.map((to) => {
                      const ok = allowed(order, to);
                      const blockedByPayment = to === 'preparing' && !ok && requiresPayment;
                      return (
                        <Button
                          key={to}
                          size="sm"
                          variant={to === 'cancelled' ? 'ghost' : 'outline'}
                          className={to === 'cancelled'
                            ? 'text-muted-foreground hover:text-destructive' : undefined}
                          disabled={!canAuthor || !ok || setFulfilment.isPending}
                          title={
                            !canAuthor ? 'Only the active Food Coordinator can do this'
                            : blockedByPayment ? 'This order has not been paid for'
                            : undefined
                          }
                          onClick={() => (to === 'cancelled'
                            ? setToCancel(order)
                            : setFulfilment.mutate({ orderId: order.id, toStatus: to }))}
                        >
                          {to === 'cancelled' ? 'Cancel' : FOOD_FULFILMENT_LABEL[to]}
                        </Button>
                      );
                    })}
                  </div>
                )}

                {requiresPayment && order.payment_status !== 'paid'
                  && order.fulfilment_status === 'confirmed' && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Cannot start: this order has not been paid for.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Cancelling is irreversible and the employee sees it: confirm, with a reason. */}
      <AlertDialog open={!!toCancel} onOpenChange={(o) => { if (!o) { setToCancel(null); setCancelReason(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {toCancel?.order_reference}?</AlertDialogTitle>
            <AlertDialogDescription>
              The servings go back on the menu and the employee sees the reason on their
              order. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label htmlFor="food-cancel-reason" className="text-xs font-medium text-muted-foreground">
            Reason (required)
          </label>
          <Textarea
            id="food-cancel-reason"
            rows={2}
            maxLength={500}
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Keep order</AlertDialogCancel>
            <AlertDialogAction
              disabled={cancelReason.trim().length < 3 || setFulfilment.isPending}
              onClick={() => {
                if (!toCancel) return;
                setFulfilment.mutate({
                  orderId: toCancel.id, toStatus: 'cancelled', note: cancelReason.trim(),
                });
                setToCancel(null); setCancelReason('');
              }}
            >
              Cancel order
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
