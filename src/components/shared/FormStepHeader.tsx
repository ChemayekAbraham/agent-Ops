import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FormStepHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  /** Optional step counter shown as a subtle pill, e.g. "Step 1 of 2". */
  stepLabel?: string;
  className?: string;
}

/**
 * Clean, minimalist section header used across the registration / listing
 * wizards. A soft icon badge + a bold title + a single muted helper line —
 * no emojis, generous whitespace, easy to scan for an ordinary user.
 */
export default function FormStepHeader({
  icon: Icon,
  title,
  subtitle,
  stepLabel,
  className,
}: FormStepHeaderProps) {
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        {stepLabel && (
          <span className="text-[11px] font-semibold uppercase tracking-wide text-primary/70">
            {stepLabel}
          </span>
        )}
        <h3 className="text-base font-semibold leading-tight text-foreground">{title}</h3>
        {subtitle && (
          <p className="mt-0.5 text-sm leading-snug text-muted-foreground">{subtitle}</p>
        )}
      </div>
    </div>
  );
}