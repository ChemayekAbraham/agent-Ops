import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ClipboardList, UtensilsCrossed } from 'lucide-react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { OrderStatusPair } from '@/components/food/FoodStatusBadges';
import FoodOrderDetailDialog from '@/components/food/FoodOrderDetailDialog';
import {
  useMyFoodOrders, useCancelMyFoodOrder, useFoodSession, formatUgx,
  type FoodOrderDetail,
} from '@/hooks/useFoodService';

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** An employee may only withdraw their own order before the kitchen starts it. */
function canWithdraw(o: FoodOrderDetail): boolean {
  return o.fulfilment_status === 'confirmed' && o.payment_status !== 'paid';
}

export default function MyFoodOrdersPage() {
  useFoodSession();

  const { data: orders, isLoading, isError, error, refetch } = useMyFoodOrders();
  const cancelOrder = useCancelMyFoodOrder();

  const [detail, setDetail] = useState<FoodOrderDetail | null>(null);
  const [toWithdraw, setToWithdraw] = useState<FoodOrderDetail | null>(null);

  return (
    <PersonalLayout title="My canteen orders" backTo="/me/food" backLabel="Back to Canteen">
      <div className="mx-auto w-full max-w-3xl space-y-5 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold sm:text-xl">My orders</h1>
            <p className="text-sm text-muted-foreground">
              Everything you have ordered from the canteen.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/me/food">
              <UtensilsCrossed className="mr-2 h-4 w-4" aria-hidden="true" />
              Today&rsquo;s menu
            </Link>
          </Button>
        </header>

        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-2 rounded-xl border border-border/70 p-4">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
                <Skeleton className="h-5 w-40" />
              </div>
            ))}
          </div>
        )}

        {isError && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium">Your orders could not be loaded</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {(error as Error)?.message ?? 'Please try again.'}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => refetch()}>Try again</Button>
          </div>
        )}

        {!isLoading && !isError && (orders ?? []).length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border/70 bg-card p-10 text-center">
            <ClipboardList className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm font-medium">You have not ordered anything yet</p>
            <p className="text-xs text-muted-foreground">
              Your orders will appear here once you place one.
            </p>
            <Button asChild size="sm" className="mt-2">
              <Link to="/me/food">Browse today&rsquo;s menu</Link>
            </Button>
          </div>
        )}

        <ul className="space-y-3">
          {(orders ?? []).map((order) => (
            <li
              key={order.id}
              className="rounded-xl border border-border/70 bg-card p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{order.order_reference}</p>
                  <p className="text-xs text-muted-foreground">{when(order.placed_at)}</p>
                </div>
                <span className="text-sm font-semibold tabular-nums">
                  {formatUgx(order.total_ugx)}
                </span>
              </div>

              <p className="mt-2 truncate text-xs text-muted-foreground">
                {order.items.map((i) => `${i.quantity} × ${i.meal_name}`).join(', ')}
              </p>

              <OrderStatusPair
                className="mt-3"
                payment={order.payment_status}
                fulfilment={order.fulfilment_status}
                mode={order.payment_mode}
              />

              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setDetail(order)}>
                  View details
                </Button>
                {canWithdraw(order) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setToWithdraw(order)}
                  >
                    Withdraw
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <FoodOrderDetailDialog
        order={detail}
        open={!!detail}
        onOpenChange={(o) => !o && setDetail(null)}
        allowProblemReport
      />

      <AlertDialog open={!!toWithdraw} onOpenChange={(o) => !o && setToWithdraw(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw this order?</AlertDialogTitle>
            <AlertDialogDescription>
              {toWithdraw?.order_reference} will be cancelled and the servings returned
              to the menu. You can order again while the window is still open.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={cancelOrder.isPending}
              onClick={() => {
                if (!toWithdraw) return;
                cancelOrder.mutate(
                  { orderId: toWithdraw.id },
                  { onSettled: () => setToWithdraw(null) },
                );
              }}
            >
              Withdraw order
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PersonalLayout>
  );
}
