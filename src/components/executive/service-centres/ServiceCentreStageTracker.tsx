import { Check, Clock, Wallet, XCircle } from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { getServiceCentreStage } from '@/lib/serviceCentreStage';

interface Props {
  setup: Parameters<typeof getServiceCentreStage>[0];
  className?: string;
}

/**
 * Shows the approval queue for one service centre: which dashboard it is
 * sitting on right now, what is already done, and a clear funded banner once
 * the CFO has released the money.
 */
export function ServiceCentreStageTracker({ setup, className }: Props) {
  const stage = getServiceCentreStage(setup);

  return (
    <div className={`space-y-2 rounded-lg border border-border/70 bg-muted/30 p-2.5 ${className ?? ''}`}>
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold text-foreground">Approval queue</span>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold ${
            stage.isFunded
              ? 'bg-emerald-500/15 text-emerald-600'
              : stage.isStopped
                ? 'bg-destructive/15 text-destructive'
                : 'bg-primary/10 text-primary'
          }`}
        >
          {stage.label}
        </span>
      </div>

      <ol className="space-y-1">
        {stage.steps.map((step) => (
          <li key={step.key} className="flex items-start gap-2">
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
                step.state === 'done'
                  ? 'bg-emerald-500/15 text-emerald-600'
                  : step.state === 'current'
                    ? 'bg-primary/15 text-primary'
                    : step.state === 'stopped'
                      ? 'bg-destructive/15 text-destructive'
                      : 'bg-muted text-muted-foreground'
              }`}
            >
              {step.state === 'done' ? (
                <Check className="h-2.5 w-2.5" />
              ) : step.state === 'stopped' ? (
                <XCircle className="h-2.5 w-2.5" />
              ) : step.key === 'funded' ? (
                <Wallet className="h-2.5 w-2.5" />
              ) : (
                <Clock className="h-2.5 w-2.5" />
              )}
            </span>
            <span className="min-w-0">
              <span
                className={`text-[11px] font-semibold ${
                  step.state === 'upcoming' ? 'text-muted-foreground' : 'text-foreground'
                }`}
              >
                {step.dashboard}
              </span>
              <span className="block text-[10px] leading-tight text-muted-foreground">
                {step.action}
                {step.state === 'current' ? ' · waiting here now' : ''}
              </span>
            </span>
          </li>
        ))}
      </ol>

      {stage.isFunded && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2">
          <p className="flex items-center gap-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-400">
            <Wallet className="h-3 w-3" />
            FUNDED{stage.fundedAmount != null ? ` · ${formatUGX(stage.fundedAmount)}` : ''}
          </p>
          <p className="text-[10px] text-emerald-700/80 dark:text-emerald-400/80">
            {stage.fundedPayee ? `Paid to ${stage.fundedPayee}` : 'Spend approved by CFO'}
            {stage.fundedAt ? ` · ${format(new Date(stage.fundedAt), 'dd MMM yyyy HH:mm')}` : ''}
          </p>
        </div>
      )}

      {stage.isStopped && stage.stoppedReason && (
        <p className="text-[10px] text-destructive">Reason: {stage.stoppedReason}</p>
      )}
    </div>
  );
}

export default ServiceCentreStageTracker;
