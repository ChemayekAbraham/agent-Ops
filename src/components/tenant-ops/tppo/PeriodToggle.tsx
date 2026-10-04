import { cn } from '@/lib/utils';

export type TppoGranularity = 'day' | 'week' | 'month';

const OPTIONS: { value: TppoGranularity; label: string }[] = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];

interface PeriodToggleProps {
  value: TppoGranularity;
  onChange: (next: TppoGranularity) => void;
}

export function PeriodToggle({ value, onChange }: PeriodToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Reporting period"
      className="flex w-full max-w-md items-stretch rounded-xl border border-border bg-muted/70 p-1 shadow-sm sm:inline-flex sm:items-center"
    >
      {OPTIONS.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'min-h-[44px] flex-1 basis-0 rounded-md px-2 py-2 text-sm font-medium transition-colors sm:min-h-0 sm:px-4',
              selected
                ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
                : 'bg-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export default PeriodToggle;
