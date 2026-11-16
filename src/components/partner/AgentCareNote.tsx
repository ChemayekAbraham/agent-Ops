import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useSelfSupportFeePolicy } from '@/hooks/useSelfSupportFeePolicy';
import { formatUGX } from '@/lib/rentCalculations';

/**
 * Owner-approved Cover fee line for self-support details.
 * Renders nothing while the fee switch is off or the fee is 0, so screens look as before.
 */
export function AgentCareNote({
  kind,
  rent,
  className = '',
}: {
  kind: 'tenant' | 'house';
  rent: number;
  className?: string;
}) {
  const { enabled, fee, pay } = useSelfSupportFeePolicy();
  const rentValue = Number(rent || 0);
  const feeValue = fee(rentValue);
  if (!enabled || feeValue <= 0) return null;
  const label = 'Cover fee';

  return (
    <div className={`flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground ${className}`}>
      <p className="min-w-0">
        {kind === 'house' ? (
          <>
            Includes <span className="font-semibold text-foreground">Cover fee:</span> a local agent checks this
            house and follows up the placement. Your full amount earns Rent Profit Share.
          </>
        ) : (
          <>
            <span className="font-semibold text-foreground">Cover fee included:</span> tenant checks and payment
            follow-up on the ground. You earn Rent Profit Share on the full amount.
          </>
        )}
      </p>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            aria-label={`${label} amount`}
            className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto px-3 py-2 text-xs" onClick={(e) => e.stopPropagation()}>
          {label}: {formatUGX(feeValue)} of {formatUGX(pay(rentValue))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
