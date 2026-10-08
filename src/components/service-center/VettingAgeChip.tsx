import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatAge } from '@/lib/vettingOverdueCopy';

interface Props {
  createdAt?: string | null;
  warnHours?: number;
  overdueHours?: number;
  className?: string;
}

/** Waiting-time chip: neutral, amber from warn hours, red from the overdue limit. */
export function VettingAgeChip({ createdAt, warnHours = 36, overdueHours = 48, className }: Props) {
  if (!createdAt) return null;
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return null;
  const hours = (Date.now() - t) / 3_600_000;
  const tone = hours >= overdueHours ? 'red' : hours >= warnHours ? 'amber' : 'neutral';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums',
        tone === 'red' && 'border-destructive/40 bg-destructive/10 text-destructive',
        tone === 'amber' && 'border-warning/50 bg-warning/15 text-foreground',
        tone === 'neutral' && 'border-border bg-muted text-muted-foreground',
        className,
      )}
      aria-label={`Waiting ${formatAge(hours)}`}
    >
      <Clock className="h-3 w-3" aria-hidden />
      {formatAge(hours)}
    </span>
  );
}
