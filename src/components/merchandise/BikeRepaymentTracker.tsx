import { format } from 'date-fns';
import { CheckCircle2, Receipt } from 'lucide-react';

import { Progress } from '@/components/ui/progress';
import { formatUGX } from '@/lib/rentCalculations';
import { useBikeLeaseRepayment } from '@/hooks/useBikeLeaseRepayment';

interface Props {
  userId?: string;
  saleId?: string;
}

/**
 * Live repayment tracker for an active bike lease: total paid so far, balance
 * left, and every deduction recorded until the lease is fully cleared.
 */
export default function BikeRepaymentTracker({ userId, saleId }: Props) {
  const { plan, deductions, paid, original, remaining, progressPct, cleared } =
    useBikeLeaseRepayment(userId, saleId);

  if (!plan) return null;

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold flex items-center gap-1.5">
          <Receipt className="h-3.5 w-3.5 text-primary" /> Repayment tracker
        </p>
        {cleared && (
          <span className="text-[11px] font-semibold text-emerald-600 flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" /> Fully cleared
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Total paid</p>
          <p className="text-xs font-bold">{formatUGX(paid)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Balance left</p>
          <p className="text-xs font-bold">{formatUGX(remaining)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Total price</p>
          <p className="text-xs font-bold">{formatUGX(original)}</p>
        </div>
      </div>

      <div className="space-y-1">
        <Progress value={progressPct} className="h-1.5" />
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>{progressPct}% paid</span>
          {plan.daily_deduction_amount ? (
            <span>{formatUGX(Number(plan.daily_deduction_amount))} a day</span>
          ) : null}
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-[11px] font-semibold text-muted-foreground">
          Payments recorded ({deductions.length})
        </p>
        {deductions.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No payment has been taken off this bike yet. Each deduction shows here as it happens.
          </p>
        ) : (
          <div className="max-h-44 overflow-y-auto divide-y divide-border rounded-md border border-border">
            {deductions.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-2 px-2 py-1.5">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold">{formatUGX(Number(d.amount))}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {format(new Date(d.created_at), 'd MMM yyyy, HH:mm')}
                  </p>
                </div>
                <p className="text-[10px] text-muted-foreground whitespace-nowrap">
                  Left {formatUGX(Number(d.outstanding_after))}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
