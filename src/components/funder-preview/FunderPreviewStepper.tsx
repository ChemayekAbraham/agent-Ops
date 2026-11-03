import { cn } from '@/lib/utils';

const STEPS = ['Pick', 'Review', 'Confirm'] as const;

/** Three-step progress for the support flow. The words carry the meaning; the bars only echo it. */
export function FunderPreviewStepper({ current, className }: { current: 0 | 1 | 2; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      <div aria-hidden className="grid grid-cols-3 gap-1.5">
        {STEPS.map((step, index) => (
          <span
            key={step}
            className={cn(
              'h-1.5 rounded-full transition-colors duration-500 motion-reduce:transition-none',
              index <= current ? 'bg-primary' : 'bg-border',
            )}
          />
        ))}
      </div>
      <p className="text-[13px]">
        <span className="font-bold text-primary">
          Step {current + 1} of 3
        </span>{' '}
        <span className="text-muted-foreground">· {STEPS[current]}</span>
      </p>
    </div>
  );
}
