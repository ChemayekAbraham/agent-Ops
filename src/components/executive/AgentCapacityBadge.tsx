import { AgentCapacity, AGENT_RENT_CAP_UGX } from '@/hooks/useAgentCapacityMap';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { DailyRatingThresholdPopover } from '@/components/shared/DailyRatingThresholdPopover';
import { WhyRatingPopover } from '@/components/shared/WhyRatingPopover';

const TIER_TONE: Record<AgentCapacity['tier'], string> = {
  Positive:   'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  Fair:       'bg-amber-500/15 text-amber-700 border-amber-500/30',
  Bad:        'bg-orange-500/15 text-orange-700 border-orange-500/30',
  'Very Bad': 'bg-destructive/15 text-destructive border-destructive/30',
  Starter:    'bg-violet-500/15 text-violet-700 border-violet-500/30',
};

const DAILY_RATING_TONE: Record<AgentCapacity['daily_rating'], string> = {
  'Very Good': 'bg-emerald-600/20 text-emerald-800 border-emerald-600/40',
  'Good':      'bg-emerald-500/15 text-emerald-700 border-emerald-500/40',
  'Fair':      'bg-amber-500/15 text-amber-700 border-amber-500/40',
  'Bad':       'bg-orange-500/15 text-orange-700 border-orange-500/40',
  'Very Bad':  'bg-destructive/15 text-destructive border-destructive/40',
  'Starter':   'bg-violet-500/15 text-violet-700 border-violet-500/40',
};

function fmtShort(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toLocaleString();
}

/**
 * Compact inline capacity chip designed to sit next to an agent's name.
 * Variants:
 *  - "chip"   : single pill (tier + used/100M%)
 *  - "stack"  : two-line stacked (chip + tiny progress bar)
 */
export function AgentCapacityBadge({
  capacity,
  loading,
  variant = 'chip',
  className,
}: {
  capacity?: AgentCapacity;
  loading?: boolean;
  variant?: 'chip' | 'stack';
  className?: string;
}) {
  if (loading) {
    return (
      <span
        className={cn(
          'inline-flex h-4 w-16 rounded-full bg-muted animate-pulse',
          className,
        )}
      />
    );
  }
  if (!capacity) return null;

  const {
    tier, used, pct, headroom, per_tenant_max, response_rate,
    responding_tenant_days, expected_tenant_days,
    paying_tenants_last_week, active_tenant_count,
    unfunded_tenant_count,
    daily_status, daily_rating, today_response_pct, paid_today, expected_daily,
  } = capacity;
  const tone = TIER_TONE[tier];
  const barTone =
    pct >= 95 ? 'bg-destructive' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500';

  const dailyTone = DAILY_RATING_TONE[daily_rating];
  const blockedSuffix = daily_status === 'blocked' ? ' · Blocked' : '';
  const dailyLabel =
    daily_rating === 'Starter'
      ? 'New'
      : `${daily_rating}${blockedSuffix}`;
  const dailyTitleLine =
    daily_status === 'starter'
      ? `Starter agent — always allowed to post the first rent request.`
      : `Today: collected UGX ${formatUGX(paid_today)} of ` +
        `UGX ${formatUGX(expected_daily)} (${Math.round(today_response_pct * 100)}%). ` +
        `Rating: ${daily_rating}. ` +
        (daily_status === 'good'
          ? `≥ 20% → ALLOWED to post new rent requests today.`
          : `< 20% → BLOCKED from posting new rent requests today.`);

  const title =
    `${dailyTitleLine}\n` +
    `Tier: ${tier}\n` +
    `Last 7 days: ${paying_tenants_last_week} of ${active_tenant_count} tenants paid\n` +
    `Not Funded: ${unfunded_tenant_count} tenant${unfunded_tenant_count === 1 ? '' : 's'}\n` +
    `Active exposure: UGX ${formatUGX(used)} / ${formatUGX(AGENT_RENT_CAP_UGX)} (${pct}%)\n` +
    `Headroom: UGX ${formatUGX(headroom)}\n` +
    `Last 7d tenant response: ${Math.round(response_rate * 100)}% ` +
    `(${responding_tenant_days}/${expected_tenant_days} tenant-day responses)\n` +
    `Per-tenant rent limit: UGX ${formatUGX(per_tenant_max)}`;

  if (variant === 'stack') {
    return (
      <div className={cn('flex flex-col gap-0.5 min-w-[90px]', className)} title={title}>
        <div className="flex flex-wrap items-center gap-1">
          <span
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0 rounded-full border text-[10px] font-bold leading-4',
              dailyTone,
            )}
          >
            {dailyLabel}
          </span>
          <WhyRatingPopover capacity={capacity} className="scale-90" />
          <DailyRatingThresholdPopover className="scale-90" />
          <span
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0 rounded-full border text-[10px] font-bold leading-4',
              tone,
            )}
          >
            {tier} · {Math.round(response_rate * 100)}%
          </span>
        </div>
        <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
          <div className={cn('h-full transition-all', barTone)} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums leading-3">
          {paying_tenants_last_week}/{active_tenant_count} paid 7d · {fmtShort(headroom)} room
        </span>
      </div>
    );
  }

  return (
    <span title={title} className={cn('inline-flex items-center gap-1', className)}>
      <span
        className={cn(
          'inline-flex items-center gap-1 px-1.5 py-0 rounded-full border text-[10px] font-bold leading-4',
          dailyTone,
        )}
      >
        {dailyLabel}
      </span>
      <WhyRatingPopover capacity={capacity} className="scale-90" />
      <DailyRatingThresholdPopover className="scale-90" />
      <span
        className={cn(
          'inline-flex items-center gap-1 px-1.5 py-0 rounded-full border text-[10px] font-bold leading-4',
          tone,
        )}
      >
        {tier}
        <span className="opacity-70 font-semibold">
          · {paying_tenants_last_week}/{active_tenant_count} paid 7d
        </span>
      </span>
    </span>
  );
}

export default AgentCapacityBadge;