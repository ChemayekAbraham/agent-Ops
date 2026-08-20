import { ReactNode, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ChevronLeft, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import eWalletPanaAsset from '@/assets/e-wallet-pana.svg.asset.json';

export interface Step {
  id: string;
  title: string;
  description?: string;
}

interface StepperModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  steps: Step[];
  currentStep: number;
  onStepChange: (step: number) => void;
  children: ReactNode;
  showNavigation?: boolean;
  canGoBack?: boolean;
  canGoNext?: boolean;
  nextLabel?: string;
  /** When true, the Next/Confirm button shows a spinner, becomes
   *  non-interactive, and (optionally) swaps its label to `nextBusyLabel`. */
  nextBusy?: boolean;
  nextBusyLabel?: string;
  /** Return `false` (or a promise resolving to `false`) to veto auto-advance.
   *  Useful when the parent wants to run validation/refetch on tap and keep
   *  the user on the current step if the check fails. */
  onNext?: () => void | boolean | Promise<void | boolean>;
  onComplete?: () => void;
  isProcessing?: boolean;
  isComplete?: boolean;
  hideProgress?: boolean;
}

export default function StepperModal({
  open,
  onOpenChange,
  title,
  steps,
  currentStep,
  onStepChange,
  children,
  showNavigation = true,
  canGoBack = true,
  canGoNext = true,
  nextLabel = 'Continue',
  nextBusy = false,
  nextBusyLabel,
  onNext,
  onComplete,
  isProcessing = false,
  isComplete = false,
  hideProgress = false,
}: StepperModalProps) {
  const progress = ((currentStep + 1) / steps.length) * 100;
  const isLastStep = currentStep === steps.length - 1;
  const currentStepData = steps[currentStep];

  const handleBack = () => {
    if (currentStep > 0) {
      onStepChange(currentStep - 1);
    }
  };

  const [advancing, setAdvancing] = useState(false);
  const handleNext = async () => {
    if (advancing) return;
    if (isLastStep) {
      onComplete?.();
      return;
    }
    if (!onNext) {
      onStepChange(currentStep + 1);
      return;
    }
    setAdvancing(true);
    try {
      const result = await onNext();
      if (result !== false) onStepChange(currentStep + 1);
    } finally {
      setAdvancing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] p-0 gap-0 overflow-y-auto block">
        <img
          src={eWalletPanaAsset.url}
          alt="Withdraw illustration"
          className="w-full h-28 object-contain mt-4"
        />
        {/* Header */}
        <DialogHeader className="p-4 pb-3 border-b">
          <div className="flex items-center gap-3">
            {currentStep > 0 && canGoBack && !isProcessing && !isComplete && (
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8 -ml-2"
                onClick={handleBack}
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
            )}
            <div className="flex-1">
              <DialogTitle className="text-lg">{title}</DialogTitle>
              {currentStepData && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Step {currentStep + 1} of {steps.length}: {currentStepData.title}
                </p>
              )}
            </div>
          </div>
          
          {/* Progress bar */}
          {!hideProgress && !isComplete && (
            <Progress value={progress} className="h-1 mt-3" />
          )}
        </DialogHeader>

        {/* Step indicators */}
        {!hideProgress && !isComplete && (
          <div className="flex justify-center gap-2 p-3 bg-muted/30">
            {steps.map((step, index) => (
              <div 
                key={step.id}
                className={cn(
                  'h-1.5 rounded-full transition-all',
                  index < currentStep ? 'w-8 bg-primary' :
                  index === currentStep ? 'w-8 bg-primary' :
                  'w-4 bg-muted-foreground/30'
                )}
              />
            ))}
          </div>
        )}

        {/* Content */}
        <div className="p-4">
          {children}
        </div>

        {/* Navigation */}
        {showNavigation && !isComplete && !isProcessing && (
          <div className="p-4 border-t bg-muted/20">
            <Button
              onClick={handleNext}
              disabled={!canGoNext || nextBusy || advancing}
              aria-busy={nextBusy || advancing || undefined}
              className="w-full"
              size="lg"
            >
              {(nextBusy || advancing) && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
              )}
              {nextBusy || advancing
                ? (nextBusyLabel ?? 'Working…')
                : isLastStep
                ? 'Confirm'
                : nextLabel}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
