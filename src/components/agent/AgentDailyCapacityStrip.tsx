import { useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useAgentCapacityMap, DAILY_ELIGIBILITY_THRESHOLD, type AgentCapacity } from '@/hooks/useAgentCapacityMap';
import { useOwnExpectedSplit } from '@/hooks/useAgentExpectedSplit';
import { formatUGX } from '@/lib/rentCalculations';
import { CalendarCheck2, CheckCircle2, Lock, Loader2, AlarmClock } from 'lucide-react';

const RATING_TONE: Record<AgentCapacity['daily_rating'], string> = {
  'Very Good': 'bg-emerald-600/15 text-emerald-700 border-emerald-600/40',
  'Good':      'bg-emerald-500/15 text-emerald-700 border-emerald-500/40',
  'Fair':      'bg-amber-500/15 text-amber-700 border-amber-500/40',
  'Bad':       'bg-orange-500/15 text-orange-700 border-orange-500/40',
  'Very Bad':  'bg-destructive/15 text-destructive border-destructive/40',
  'Starter':   'bg-violet-500/15 text-violet-700 border-violet-500/40',
};

/**
 * Compact, agent-facing daily capacity strip for the Tenants screen.
 * Keeps collection amounts separate from tenant-reach posting progress.
 */
export function getTenantCoveragePresentation(cap: Pick<AgentCapacity,
  'tenants_due' | 'tenants_paid_today' | 'coverage_today' | 'coverage_yesterday'
>) {
  const bestCoverage = Math.max(cap.coverage_today, cap.coverage_yesterday);
  return {
    progressPct: cap.tenants_due > 0 ? Math.min(100, Math.max(0, Math.round(bestCoverage * 100))) : 100,
    todayRemaining: Math.max(0, Math.ceil(cap.tenants_due * DAILY_ELIGIBILITY_THRESHOLD) - cap.tenants_paid_today),
    yesterdayCarrying: cap.coverage_today < DAILY_ELIGIBILITY_THRESHOLD
      && cap.coverage_yesterday >= DAILY_ELIGIBILITY_THRESHOLD,
    bestDay: cap.coverage_yesterday > cap.coverage_today ? 'yesterday' : 'today',
  };
}

export function AgentDailyCapacityStrip() {
  const { user } = useAuth();
  const ids = useMemo(() => (user?.id ? [user.id] : []), [user?.id]);
  const { data, isLoading } = useAgentCapacityMap(ids);
  const cap = user?.id ? data?.get(user.id) : undefined;
  // Splits the pinned target into in-term rent vs past-term arrears. One RPC,
  // batched with any other agent on screen — never call per list row.
  const { data: split } = useOwnExpectedSplit(user?.id ?? null);

  if (!user?.id) return null;

  if (isLoading && !cap) {
    return (
      <div className="rounded-2xl border-2 border-border/60 bg-card p-4 flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading today&apos;s capacity…</span>
      </div>
    );
  }
  if (!cap) return null;

  const { progressPct, todayRemaining, yesterdayCarrying, bestDay } = getTenantCoveragePresentation(cap);
  const canPost = cap.can_post_rent_today;
  const barTone = canPost ? 'bg-primary' : 'bg-destructive';

  return (
    <div className="rounded-2xl border-2 border-border/60 bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="h-10 w-10 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
            <CalendarCheck2 className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-bold text-foreground">Today&apos;s capacity</p>
            <p className="text-xs text-muted-foreground">Reach at least half your tenants · any payment counts</p>
          </div>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-xs font-extrabold border shrink-0 ${RATING_TONE[cap.daily_rating]}`}>
          {cap.daily_rating}
        </span>
      </div>

      <div>
        <p className="text-xs text-muted-foreground mb-1">Money collected today</p>
        <div className="flex flex-wrap items-center justify-between gap-x-2 text-sm font-bold tabular-nums mb-1.5">
          <span className="text-foreground">{formatUGX(cap.paid_today)}</span>
          <span className="text-muted-foreground">of {formatUGX(cap.expected_daily)}</span>
        </div>
        {/* In-term vs past-term breakdown. Only appears when part of today's
            target comes from Rent Plans already past their end date — routine
            rent needs no callout. The big total above never changes. */}
        {split && split.arrearsUgx > 0 && (
          <div className="flex items-start gap-2 mt-2 rounded-xl bg-amber-500/10 border border-amber-500/30 px-3 py-2">
            <AlarmClock className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground leading-snug">
              <strong className="text-foreground tabular-nums">{formatUGX(split.inTermUgx)}</strong> is today&apos;s rent
              {' · '}
              <strong className="text-amber-700 tabular-nums">{formatUGX(split.arrearsUgx)}</strong> is owed by{' '}
              <strong className="text-foreground tabular-nums">{split.arrearsPlans}</strong>{' '}
              {split.arrearsPlans === 1 ? 'tenant' : 'tenants'} past their Rent Plan end date — chase them too
            </p>
          </div>
        )}
      </div>

      <div className="space-y-1.5 border-t border-border pt-3">
        <p className="text-xs font-semibold text-foreground">Tenants reached · Rent Plan access</p>
        <p className="text-sm text-foreground tabular-nums leading-snug">
          {cap.tenants_paid_today} of {cap.tenants_due} tenants paid today
          {' · '}{cap.tenants_paid_yesterday} of {cap.tenants_due} yesterday
        </p>
        {yesterdayCarrying && canPost && (
          <p className="text-xs text-primary leading-snug">
            Yesterday&apos;s {cap.tenants_paid_yesterday} of {cap.tenants_due} is keeping you unlocked.
          </p>
        )}
        <div
          role="progressbar"
          aria-label="Tenants reached, best of today or yesterday"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPct}
          className="h-3 w-full rounded-full bg-muted overflow-hidden"
        >
          <div className={`h-full ${barTone} transition-all motion-reduce:transition-none`} style={{ width: `${progressPct}%` }} />
        </div>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="text-xs text-muted-foreground leading-snug">
            {cap.tenants_due <= 0 ? 'No tenants owing in the posting check' : (
              <>{progressPct}% of tenants reached · {bestDay} counts</>
            )}
            {todayRemaining > 0 && (
              <><br /><strong className="text-foreground">{todayRemaining} more {todayRemaining === 1 ? 'tenant' : 'tenants'}</strong> to reach half today</>
            )}
          </p>
          <p className="text-xs font-semibold text-muted-foreground shrink-0 tabular-nums">
            {new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Kampala', weekday: 'short', day: 'numeric', month: 'short' })}
          </p>
        </div>
      </div>

      {cap.weekly_plan_count > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs">
          <span className="text-muted-foreground">
            <strong className="text-foreground">{cap.weekly_plan_count}</strong> weekly plan{cap.weekly_plan_count !== 1 ? 's' : ''} tracked separately
            {' · '}<span className="tabular-nums">{formatUGX(cap.weekly_expected_week)}</span>/week
          </span>
          {cap.weekly_lapsed_count > 0 && (
            <span className="font-semibold text-destructive shrink-0">
              {cap.weekly_lapsed_count} unpaid this week
            </span>
          )}
        </div>
      )}

      <div
        className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold ${
          canPost
            ? 'bg-emerald-500/10 text-emerald-700'
            : 'bg-destructive/10 text-destructive'
        }`}
      >
        {canPost ? (
          <>
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>You can post new Rent Plans today</span>
          </>
        ) : (
          <>
            <Lock className="h-4 w-4 shrink-0" />
            <span>
              {todayRemaining > 0 ? (
                <>Collect from <strong>{todayRemaining}</strong> more {todayRemaining === 1 ? 'tenant' : 'tenants'} to unlock new rents</>
              ) : (
                <>Collect from your tenants with overdue balances to unlock new Rent Plans</>
              )}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export default AgentDailyCapacityStrip;