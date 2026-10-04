import { CheckCircle2, Circle, AlertCircle, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface IdentityChecklistItem {
  id: 'payout' | 'front' | 'back' | 'selfie';
  label: string;
  isDone: boolean;
  isRejected?: boolean;
  note?: string;
}

export interface VerificationChecklistProps {
  payoutDone: boolean;
  payoutRejected?: boolean;
  payoutNote?: string;
  idFrontDone: boolean;
  idFrontRejected?: boolean;
  idFrontNote?: string;
  idBackDone: boolean;
  idBackRejected?: boolean;
  idBackNote?: string;
  selfieDone: boolean;
  selfieRejected?: boolean;
  selfieNote?: string;
  variant?: 'compact' | 'card';
  className?: string;
}

export default function IdentityVerificationChecklist({
  payoutDone,
  payoutRejected,
  payoutNote,
  idFrontDone,
  idFrontRejected,
  idFrontNote,
  idBackDone,
  idBackRejected,
  idBackNote,
  selfieDone,
  selfieRejected,
  selfieNote,
  variant = 'compact',
  className,
}: VerificationChecklistProps) {
  const items: IdentityChecklistItem[] = [
    {
      id: 'payout',
      label: 'Payout number',
      isDone: payoutDone,
      isRejected: payoutRejected,
      note: payoutNote,
    },
    {
      id: 'front',
      label: 'ID front',
      isDone: idFrontDone,
      isRejected: idFrontRejected,
      note: idFrontNote,
    },
    {
      id: 'back',
      label: 'ID back',
      isDone: idBackDone,
      isRejected: idBackRejected,
      note: idBackNote,
    },
    {
      id: 'selfie',
      label: 'Selfie',
      isDone: selfieDone,
      isRejected: selfieRejected,
      note: selfieNote,
    },
  ];

  if (variant === 'compact') {
    return (
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-1.5 sm:gap-2 px-3 py-2 rounded-lg bg-muted/40 border border-border text-xs font-medium',
          className
        )}
        role="status"
        aria-label="Identity verification progress"
      >
        {items.map((item, index) => (
          <div key={item.id} className="flex items-center gap-1">
            {index > 0 && <span className="text-muted-foreground/30 mr-1 sm:mr-1.5 select-none" aria-hidden="true">/</span>}
            {item.isDone ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" aria-hidden="true" />
            ) : item.isRejected ? (
              <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" aria-hidden="true" />
            ) : (
              <Circle className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" aria-hidden="true" />
            )}
            <span
              className={cn(
                item.isDone
                  ? 'text-foreground font-semibold'
                  : item.isRejected
                  ? 'text-destructive font-semibold'
                  : 'text-muted-foreground'
              )}
            >
              {item.label} {item.isDone ? '✓' : item.isRejected ? '✕' : '○'}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // Card variant (for Step 1 calm state)
  return (
    <div className={cn('rounded-xl border border-border bg-card p-4 space-y-3.5 shadow-sm', className)}>
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-primary shrink-0" />
        <div>
          <h4 className="font-semibold text-sm text-foreground">Identity verification checklist</h4>
          <p className="text-xs text-muted-foreground">
            Complete these 4 details to unlock withdrawals
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              'flex items-start gap-2.5 p-2.5 rounded-lg border text-xs transition-colors',
              item.isDone
                ? 'bg-emerald-500/5 border-emerald-500/20'
                : item.isRejected
                ? 'bg-destructive/5 border-destructive/20'
                : 'bg-muted/30 border-border/60'
            )}
          >
            {item.isDone ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
            ) : item.isRejected ? (
              <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            ) : (
              <Circle className="h-4 w-4 text-muted-foreground/40 mt-0.5 shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-1">
                <span className={cn('font-medium', item.isDone ? 'text-foreground' : 'text-muted-foreground')}>
                  {item.label}
                </span>
                <span
                  className={cn(
                    'text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded',
                    item.isDone
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                      : item.isRejected
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-muted text-muted-foreground'
                  )}
                >
                  {item.isDone ? 'Done' : item.isRejected ? 'Rejected' : 'Needed'}
                </span>
              </div>
              {item.note && (
                <p
                  className={cn(
                    'text-[11px] mt-1',
                    item.isRejected ? 'text-destructive font-medium' : 'text-muted-foreground'
                  )}
                >
                  {item.note}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
