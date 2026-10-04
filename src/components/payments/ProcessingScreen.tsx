import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, Shield, CreditCard, Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';

interface ProcessingStep {
  id: string;
  label: string;
  completed: boolean;
}

interface ProcessingScreenProps {
  steps?: ProcessingStep[];
  onComplete?: () => void;
  autoProgress?: boolean;
  progressDuration?: number;
}

const defaultSteps: ProcessingStep[] = [
  { id: 'verify', label: 'Verifying payment details', completed: false },
  { id: 'process', label: 'Processing transaction', completed: false },
  { id: 'confirm', label: 'Confirming with bank', completed: false },
  { id: 'complete', label: 'Finalizing payment', completed: false },
];

export default function ProcessingScreen({
  steps = defaultSteps,
  onComplete,
  autoProgress = true,
  progressDuration = 4000,
}: ProcessingScreenProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [internalSteps, setInternalSteps] = useState(steps);

  useEffect(() => {
    if (!autoProgress) return;

    const stepDuration = progressDuration / steps.length;
    const progressInterval = 50;
    const progressIncrement = (100 / (progressDuration / progressInterval));

    const progressTimer = setInterval(() => {
      setProgress(prev => {
        const next = prev + progressIncrement;
        if (next >= 100) {
          clearInterval(progressTimer);
          return 100;
        }
        return next;
      });
    }, progressInterval);

    const stepTimer = setInterval(() => {
      setCurrentStepIndex(prev => {
        const next = prev + 1;
        if (next >= steps.length) {
          clearInterval(stepTimer);
          setTimeout(() => onComplete?.(), 500);
          return prev;
        }
        setInternalSteps(curr => 
          curr.map((s, i) => ({ ...s, completed: i < next }))
        );
        return next;
      });
    }, stepDuration);

    return () => {
      clearInterval(progressTimer);
      clearInterval(stepTimer);
    };
  }, [autoProgress, progressDuration, steps.length, onComplete]);

  return (
    <div className="py-8 text-center space-y-6">
      {/* Animated loader */}
      <div className="relative w-24 h-24 mx-auto">
        <div className="absolute inset-0 rounded-full border-4 border-primary/20" />
        <div 
          className="absolute inset-0 rounded-full border-4 border-primary border-t-transparent animate-spin"
          style={{ animationDuration: '1s' }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <Shield className="w-10 h-10 text-primary" />
        </div>
      </div>

      <div>
        <h3 className="text-xl font-semibold mb-2">Processing Payment</h3>
        <p className="text-sm text-muted-foreground">
          Please wait while we secure your transaction
        </p>
      </div>

      {/* Progress bar */}
      <div className="max-w-xs mx-auto">
        <Progress value={progress} className="h-2" />
        <p className="text-xs text-muted-foreground mt-2">{Math.round(progress)}% complete</p>
      </div>

      {/* Steps */}
      <div className="space-y-3 text-left max-w-xs mx-auto">
        {internalSteps.map((step, index) => (
          <div 
            key={step.id}
            className={cn(
              'flex items-center gap-3 text-sm transition-all',
              index > currentStepIndex && 'opacity-40'
            )}
          >
            {step.completed ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
            ) : index === currentStepIndex ? (
              <Loader2 className="w-5 h-5 text-primary animate-spin flex-shrink-0" />
            ) : (
              <div className="w-5 h-5 rounded-full border-2 border-muted-foreground/30 flex-shrink-0" />
            )}
            <span className={cn(
              step.completed && 'text-muted-foreground line-through'
            )}>
              {step.label}
            </span>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground max-w-xs mx-auto">
        Do not close this window. Your payment is being processed securely.
      </p>
    </div>
  );
}
