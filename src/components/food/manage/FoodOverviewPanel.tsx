import { AlertCircle, Info } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useFoodCoordinatorOverview, formatUgx } from '@/hooks/useFoodService';

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function FoodOverviewPanel() {
  const { data, isLoading, isError, error, refetch } = useFoodCoordinatorOverview();

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" aria-hidden="true" />
        <p className="text-sm font-medium">The overview could not be loaded</p>
        <p className="text-xs text-muted-foreground">
          {(error as Error)?.message ?? 'Please try again.'}
        </p>
        <Button size="sm" variant="outline" onClick={() => refetch()}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/*
        The rule comes from the server, never from the build. When payment is
        required and nothing can be paid, the queue will legitimately be empty —
        say so rather than letting the coordinator wonder.
      */}
      <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-200">
          {data.fulfilment_requires_payment ? (
            <>
              Payment is not open yet, and the kitchen may only prepare an order once
              its payment is <strong className="font-semibold">confirmed</strong>. Unpaid
              orders stay out of the preparation queue.
            </>
          ) : (
            <>
              Payment is made after delivery, so the kitchen prepares and hands over
              orders before they are paid. Every order keeps showing its payment status.
            </>
          )}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Orders today" value={data.orders_today} />
        <Stat label="Unpaid" value={data.unpaid_orders} hint="Awaiting payment" />
        <Stat label="Awaiting prep" value={data.awaiting_prep} />
        <Stat label="Preparing" value={data.preparing} />
        <Stat label="Ready" value={data.ready} />
        <Stat label="Completed" value={data.completed} />
        <Stat label="Cancelled" value={data.cancelled} />
        <Stat label="Menu items published" value={data.menu_published} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Stat
          label="Open exceptions"
          value={data.open_exceptions}
          hint="Issues raised during service"
        />
        {/*
          An operational figure only. This is the value of orders marked paid —
          it is not revenue, is not an accounting number, and is zero while
          payment is off.
        */}
        <Stat
          label="Paid order value"
          value={formatUgx(data.paid_order_total_ugx)}
          hint="Operational total of paid orders — not an accounting figure"
        />
      </div>
    </div>
  );
}
