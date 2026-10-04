import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { HelpCircle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import type { AgentCapacity } from '@/hooks/useAgentCapacityMap';

const RATING_TONE: Record<AgentCapacity['daily_rating'], string> = {
  'Very Good': 'text-emerald-700 bg-emerald-50 border-emerald-200',
  'Good':      'text-emerald-600 bg-emerald-50 border-emerald-200',
  'Fair':      'text-amber-700 bg-amber-50 border-amber-200',
  'Bad':       'text-orange-700 bg-orange-50 border-orange-200',
  'Very Bad':  'text-destructive bg-destructive/5 border-destructive/20',
  'Starter':   'text-violet-700 bg-violet-50 border-violet-200',
};

const TIER_RANGE: Record<AgentCapacity['daily_rating'], string> = {
  'Very Good': '≥ 75% of today\u2019s target',
  'Good':      '50–74% of today\u2019s target',
  'Fair':      '15–49% of today\u2019s target',
  'Bad':       '5–14% of today\u2019s target',
  'Very Bad':  '< 5% of today\u2019s target',
  'Starter':   'No active rents yet',
};

/**
 * "Why this rating?" — shows the exact inputs that produced the tier:
 *   - today's collection (UGX)
 *   - today's expected daily target (UGX)
 *   - resulting percentage
 *   - tier band the percentage falls into
 */
export function WhyRatingPopover({
  capacity,
  className,
}: {
  capacity: AgentCapacity;
  className?: string;
}) {
  const { paid_today, expected_daily, today_response_pct, daily_rating, daily_status } = capacity;
  const pct = Math.round((today_response_pct || 0) * 100);
  const tone = RATING_TONE[daily_rating];
  const range = TIER_RANGE[daily_rating];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center justify-center h-5 w-5 rounded-full border border-border bg-background hover:bg-muted transition-colors ${className || ''}`}
          aria-label="Why this rating?"
          title="Why this rating?"
          onClick={(e) => e.stopPropagation()}
        >
          <HelpCircle className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3 space-y-2" align="start" sideOffset={4}>
        <p className="text-xs font-bold text-foreground">Why this rating?</p>

        <div className="rounded-md border border-border bg-muted/30 p-2 space-y-1 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Collected today</span>
            <span className="font-mono font-bold text-foreground">UGX {formatUGX(paid_today)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Today&apos;s target</span>
            <span className="font-mono font-bold text-foreground">UGX {formatUGX(expected_daily)}</span>
          </div>
          <div className="flex items-center justify-between border-t border-border pt-1">
            <span className="text-muted-foreground">% of target</span>
            <span className="font-mono font-extrabold text-foreground">{pct}%</span>
          </div>
        </div>

        <div className={`rounded-md border px-2 py-1.5 flex items-center justify-between text-[11px] ${tone}`}>
          <span className="font-bold">{daily_rating}</span>
          <span className="tabular-nums">{range}</span>
        </div>

        <p className="text-[10px] text-muted-foreground leading-snug">
          {daily_status === 'starter'
            ? 'New agents are always allowed to post their first rent request.'
            : daily_status === 'good'
              ? 'At or above 50% today → allowed to post new rent requests.'
              : 'Below 50% today → blocked from posting new rent requests until you catch up.'}
        </p>
      </PopoverContent>
    </Popover>
  );
}