import { CheckCircle2, Clock, ShieldCheck, Wallet, XCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Lifecycle of a code-verified cash deposit:
 *   pending  → the request was created and a one-time code emailed to
 *              Financial Ops (awaiting the depositor to hand over cash).
 *   verified → the depositor entered the receipt code Financial Ops read
 *              back to them (cash_deposit_verifications.status = 'verified').
 *   approved → the wallet was auto-credited (deposit_requests.status =
 *              'approved'). This is the terminal happy state.
 *
 * `rejected` / `expired` short-circuit the track into a failed terminal state.
 */
export type DepositStage =
  | 'pending'
  | 'verified'
  | 'approved'
  | 'rejected'
  | 'expired';

interface StepDef {
  key: 'pending' | 'verified' | 'approved';
  label: string;
  hint: string;
  icon: typeof Clock;
}

const STEPS: StepDef[] = [
  { key: 'pending', label: 'Pending', hint: 'Code sent to Financial Ops', icon: Clock },
  { key: 'verified', label: 'Code verified', hint: 'Receipt code confirmed', icon: ShieldCheck },
  { key: 'approved', label: 'Auto-approved', hint: 'Wallet credited', icon: Wallet },
];

const STAGE_INDEX: Record<'pending' | 'verified' | 'approved', number> = {
  pending: 0,
  verified: 1,
  approved: 2,
};

function fmtTime(ts?: string | null) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-UG', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

interface DepositStatusTrackerProps {
  stage: DepositStage;
  /** Show a spinner on the stage currently being processed. */
  busyStage?: 'verified' | 'approved' | null;
  timestamps?: {
    pendingAt?: string | null;
    verifiedAt?: string | null;
    approvedAt?: string | null;
  };
  className?: string;
  /** Compact horizontal layout for dense lists. */
  compact?: boolean;
}

export default function DepositStatusTracker({
  stage,
  busyStage = null,
  timestamps,
  className,
  compact = false,
}: DepositStatusTrackerProps) {
  const failed = stage === 'rejected' || stage === 'expired';
  // For a failed track, freeze progress at whatever was last achieved.
  const activeIndex = failed
    ? (timestamps?.verifiedAt ? 1 : 0)
    : STAGE_INDEX[stage as 'pending' | 'verified' | 'approved'] ?? 0;

  const tsFor = (key: StepDef['key']) => {
    if (key === 'pending') return fmtTime(timestamps?.pendingAt);
    if (key === 'verified') return fmtTime(timestamps?.verifiedAt);
    return fmtTime(timestamps?.approvedAt);
  };

  return (
    <div className={cn('w-full', className)}>
      <div className="flex items-start">
        {STEPS.map((step, i) => {
          const done = i < activeIndex || (i === activeIndex && stage === 'approved');
          const current = i === activeIndex && !done && !failed;
          const isBusy = busyStage === step.key && current;
          const Icon = step.icon;
          const reached = i <= activeIndex;

          return (
            <div key={step.key} className="flex-1 flex flex-col items-center relative">
              {/* connector to the previous node */}
              {i > 0 && (
                <span
                  className={cn(
                    'absolute top-3.5 right-1/2 h-0.5 w-full -translate-y-1/2',
                    i <= activeIndex && !failed ? 'bg-emerald-500' : 'bg-border',
                    failed && i <= activeIndex ? 'bg-destructive/60' : '',
                  )}
                  aria-hidden
                />
              )}
              <div
                className={cn(
                  'relative z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 transition-colors',
                  done && 'bg-emerald-500 border-emerald-500 text-white',
                  current && !isBusy && 'bg-amber-500 border-amber-500 text-white',
                  isBusy && 'bg-amber-500 border-amber-500 text-white',
                  !reached && 'bg-muted border-border text-muted-foreground',
                  failed && i <= activeIndex && 'bg-destructive border-destructive text-destructive-foreground',
                )}
              >
                {isBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : failed && i === activeIndex ? (
                  <XCircle className="h-4 w-4" />
                ) : done ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <Icon className="h-3.5 w-3.5" />
                )}
              </div>
              <p
                className={cn(
                  'mt-1.5 text-center font-medium leading-tight',
                  compact ? 'text-[10px]' : 'text-xs',
                  reached ? 'text-foreground' : 'text-muted-foreground',
                  failed && i === activeIndex && 'text-destructive',
                )}
              >
                {step.label}
              </p>
              {!compact && (
                <p className="mt-0.5 text-center text-[10px] leading-tight text-muted-foreground">
                  {tsFor(step.key) ?? step.hint}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {failed && (
        <p className="mt-2 text-center text-xs font-medium text-destructive">
          {stage === 'expired'
            ? 'This deposit code expired before it was verified.'
            : 'This deposit request was rejected.'}
        </p>
      )}
    </div>
  );
}
