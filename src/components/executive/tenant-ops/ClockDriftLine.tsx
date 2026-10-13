import { useAmClockDrift } from '@/hooks/useAmClockDrift';
import { describeClockDrift } from '@/lib/payoutClockExplainer';
import { cn } from '@/lib/utils';

/** "Pages agree / N plans differ": the result of the daily check, for staff. Hidden until a check has run. */
export function ClockDriftLine() {
  const { data } = useAmClockDrift();
  const line = describeClockDrift(data);
  if (!line) return null;
  return (
    <p
      className={cn('break-words text-[11px] leading-snug', line.agree ? 'text-muted-foreground' : 'font-medium text-destructive')}
      data-testid="clock-drift-line"
    >
      {line.text}
    </p>
  );
}
