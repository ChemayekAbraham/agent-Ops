import { cn } from '@/lib/utils';
import { RENT_DESK_LABEL_TEXT, type RentDeskLabel } from '@/lib/rentDeskFilters';

const TONE: Record<RentDeskLabel, string> = {
  proven_good: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  good_agent_pick: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
  average: 'bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/30',
  watch: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
};

interface Props {
  label?: RentDeskLabel | null;
  reason?: string | null;
  score?: number | null;
  /** Show the one-line reason under the chip (default). The reason is also the chip's tooltip. */
  showReason?: boolean;
  className?: string;
}

/**
 * The tenant's paying label as a chip, with the one-line reason the server gave for it. Display only: the label, score and
 * reason all come from the server (`rent_request_desk_order`); nothing is derived here. Renders nothing until they arrive.
 */
export function PaymentLabelChip({ label, reason, score, showReason = true, className }: Props) {
  if (!label) return null;
  return (
    <span className={cn('inline-flex min-w-0 flex-col items-start gap-0.5', className)} data-testid="payment-label-chip">
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide shrink-0',
          TONE[label],
        )}
        title={reason ?? undefined}
      >
        {RENT_DESK_LABEL_TEXT[label]}
        {typeof score === 'number' && <span className="font-semibold opacity-80">{score}</span>}
      </span>
      {showReason && reason && (
        <span className="break-words text-[10px] leading-snug text-muted-foreground" data-testid="payment-label-reason">
          {reason}
        </span>
      )}
    </span>
  );
}
