import { CheckCircle, Clock, User, Briefcase, Shield, Banknote } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface StepData {
  label: string;
  description: string;
  icon: typeof User;
  completedAt?: string | null;
}

interface WithdrawalStepTrackerProps {
  variant?: 'wallet' | 'partner';
  status: string;
  createdAt: string;
  // Wallet chain (new 4-stage)
  finOpsApprovedAt?: string | null;
  cfoApprovedAt?: string | null;
  finOpsVerifiedAt?: string | null;
  processedAt?: string | null;
  // Legacy wallet props (kept for backwards compat)
  managerApprovedAt?: string | null;
  cooApprovedAt?: string | null;
  // Partner chain
  partnerOpsApprovedAt?: string | null;
  cooClearedAt?: string | null;
  cfoProcessedAt?: string | null;
}

export function WithdrawalStepTracker({
  variant = 'wallet',
  status,
  createdAt,
  finOpsApprovedAt,
  cfoApprovedAt,
  finOpsVerifiedAt,
  processedAt,
  managerApprovedAt,
  cooApprovedAt,
  partnerOpsApprovedAt,
  cooClearedAt,
  cfoProcessedAt,
}: WithdrawalStepTrackerProps) {
  const isRejected = status === 'rejected';

  const walletSteps: StepData[] = [
    { label: 'Requested', description: 'Withdrawal submitted', icon: User, completedAt: createdAt },
    { label: 'Approved & Paid', description: 'Fin Ops approved with TID', icon: Banknote, completedAt: finOpsApprovedAt || processedAt },
  ];

  const partnerSteps: StepData[] = [
    { label: 'Requested', description: 'Withdrawal submitted', icon: User, completedAt: createdAt },
    { label: 'Portfolio Review', description: 'Verification & assessment', icon: Briefcase, completedAt: partnerOpsApprovedAt },
    { label: 'Operations Clearance', description: 'Operational sign-off', icon: Shield, completedAt: cooClearedAt },
    { label: 'Treasury Payout', description: 'Final processing & payout', icon: Banknote, completedAt: cfoProcessedAt },
  ];

  const steps = variant === 'partner' ? partnerSteps : walletSteps;

  const getActiveStepIndex = () => {
    if (variant === 'partner') {
      if (status === 'approved') return 4;
      if (cfoProcessedAt) return 4;
      if (cooClearedAt) return 3;
      if (partnerOpsApprovedAt) return 2;
      return 1;
    }
    // Wallet: pending → approved (single step)
    if (status === 'approved') return 2;
    if (finOpsApprovedAt || processedAt) return 2;
    return 1;
  };

  const activeStep = isRejected ? -1 : getActiveStepIndex();

  return (
    <div className="space-y-0">
      {steps.map((step, index) => {
        const isCompleted = !isRejected && index < activeStep;
        const isCurrent = !isRejected && index === activeStep && index < 4;
        const isWaiting = !isCompleted && !isCurrent;
        const StepIcon = step.icon;
        const isLast = index === steps.length - 1;

        return (
          <div key={index} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  'w-7 h-7 rounded-full flex items-center justify-center shrink-0 border-2 transition-colors',
                  isCompleted && 'bg-emerald-500 border-emerald-500',
                  isCurrent && 'border-primary bg-primary/10 animate-pulse',
                  isWaiting && 'border-muted-foreground/30 bg-muted/50',
                  isRejected && index > 0 && 'border-muted-foreground/20 bg-muted/30',
                )}
              >
                {isCompleted ? (
                  <CheckCircle className="h-4 w-4 text-white" />
                ) : isCurrent ? (
                  <Clock className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <StepIcon className="h-3.5 w-3.5 text-muted-foreground/50" />
                )}
              </div>
              {!isLast && (
                <div
                  className={cn(
                    'w-0.5 flex-1 min-h-[24px] transition-colors',
                    isCompleted ? 'bg-emerald-500' : 'bg-muted-foreground/20',
                  )}
                />
              )}
            </div>

            <div className={cn('pb-4', isLast && 'pb-0')}>
              <p
                className={cn(
                  'text-sm font-semibold leading-tight',
                  isCompleted && 'text-emerald-600 dark:text-emerald-400',
                  isCurrent && 'text-foreground',
                  isWaiting && 'text-muted-foreground/60',
                )}
              >
                {step.label}
              </p>
              {isCompleted && step.completedAt && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  ✓ {format(new Date(step.completedAt), 'MMM d, yyyy • h:mm a')}
                </p>
              )}
              {isCurrent && (
                <p className="text-[10px] text-primary font-medium mt-0.5">
                  ⏳ In progress...
                </p>
              )}
              {isWaiting && !isRejected && (
                <p className="text-[10px] text-muted-foreground/50 mt-0.5">
                  Waiting
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
