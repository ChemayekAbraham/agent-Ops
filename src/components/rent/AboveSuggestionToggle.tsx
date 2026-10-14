import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Filter chip for the pipeline lists: show only renewals whose rent was above the server's suggestion. */
export function AboveSuggestionToggle({ on, onChange, count, className }: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** how many of the loaded requests carry the flag */
  count: number;
  className?: string;
}) {
  // Nothing to filter and not filtering: stay out of the way.
  if (count === 0 && !on) return null;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={cn(
        'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        on ? 'border-amber-500 bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200' : 'bg-background text-muted-foreground hover:bg-muted',
        className,
      )}
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      Above suggestion ({count})
    </button>
  );
}
