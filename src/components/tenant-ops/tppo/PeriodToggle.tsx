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
      className="inline-flex w-full max-w-md items-center rounded-lg border border-border bg-muted p-1"
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
              'flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors',
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
