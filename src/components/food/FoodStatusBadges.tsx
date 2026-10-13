import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  FOOD_FULFILMENT_LABEL,
  FOOD_PAYMENT_LABEL,
  FOOD_PAYMENT_MODE_LABEL,
  type FoodFulfilmentStatus,
  type FoodPaymentStatus,
  type FoodPaymentMode,
} from '@/hooks/useFoodService';

/**
 * Payment and fulfilment are independent and are always shown as two separate
 * badges. Never merge them: an order can be well through the kitchen and still
 * be unpaid, which is exactly the state everything is in right now.
 */

const FULFILMENT_TONE: Record<FoodFulfilmentStatus, string> = {
  confirmed: 'border-border bg-muted text-muted-foreground',
  preparing: 'border-warning/30 bg-warning/10 text-warning-foreground dark:text-warning',
  ready: 'border-success/30 bg-success/10 text-success',
  collected: 'border-success/30 bg-success/10 text-success',
  delivered: 'border-success/30 bg-success/10 text-success',
  cancelled: 'border-destructive/30 bg-destructive/10 text-destructive',
};

const PAYMENT_TONE: Record<FoodPaymentStatus, string> = {
  pending_payment: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  paid: 'border-success/30 bg-success/10 text-success',
  payment_failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  refund_pending: 'border-border bg-muted text-muted-foreground',
  refunded: 'border-border bg-muted text-muted-foreground',
  // type completeness only (20261013128000); reuses the payment_failed tone. Styling: Gemini.
  payment_reversed: 'border-destructive/30 bg-destructive/10 text-destructive',
};

export function FulfilmentBadge({
  status, className,
}: { status: FoodFulfilmentStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn('font-medium', FULFILMENT_TONE[status], className)}>
      {FOOD_FULFILMENT_LABEL[status] ?? status}
    </Badge>
  );
}

export function PaymentBadge({
  status, className,
}: { status: FoodPaymentStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn('font-medium', PAYMENT_TONE[status], className)}>
      {FOOD_PAYMENT_LABEL[status] ?? status}
    </Badge>
  );
}

/**
 * How the employee said they will pay after delivery. A declared intention,
 * never a payment: it sits beside the payment badge, which stays "Not paid
 * yet" until a separate process settles the order.
 */
export function PaymentModeBadge({
  mode, className,
}: { mode: FoodPaymentMode | null | undefined; className?: string }) {
  if (!mode) return null;
  return (
    <Badge variant="outline" className={cn('font-normal text-muted-foreground', className)}>
      Pays by {FOOD_PAYMENT_MODE_LABEL[mode] ?? mode}
    </Badge>
  );
}

export function OrderStatusPair({
  payment, fulfilment, mode, className,
}: {
  payment: FoodPaymentStatus;
  fulfilment: FoodFulfilmentStatus;
  /** the declared payment mode, when known */
  mode?: FoodPaymentMode | null;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <FulfilmentBadge status={fulfilment} />
      <PaymentBadge status={payment} />
      <PaymentModeBadge mode={mode} />
    </div>
  );
}
