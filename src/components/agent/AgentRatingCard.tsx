import { useAgentCapacityMap, classifyAgent, classifyDailyRating, type AgentCapacity } from '@/hooks/useAgentCapacityMap';
import { Improve7DayRatingPopover } from '@/components/shared/Improve7DayRatingPopover';
import { formatUGX } from '@/lib/rentCalculations';
import { Gauge, TrendingUp, AlertCircle } from 'lucide-react';
import { useProfile } from '@/hooks/useProfile';

interface Props {
  agentId: string;
}

export function AgentRatingCard({ agentId }: Props) {
  const { data } = useAgentCapacityMap([agentId]);
  const cap = data?.get(agentId);
  const { profile } = useProfile();

  if (!cap) {
    return (
      <div className="rounded-2xl border border-border bg-card p-4 animate-pulse">
        <div className="h-4 w-24 bg-muted rounded mb-2" />
        <div className="h-6 w-32 bg-muted rounded" />
      </div>
    );
  }

  const tierTone: Record<AgentCapacity['tier'], string> = {
    Positive:   'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
    Fair:       'bg-amber-500/15 text-amber-700 border-amber-500/30',
    Bad:        'bg-orange-500/15 text-orange-700 border-orange-500/30',
    'Very Bad': 'bg-destructive/15 text-destructive border-destructive/30',
    Starter:    'bg-violet-500/15 text-violet-700 border-violet-500/30',
  };

  const dailyRatingTone: Record<AgentCapacity['daily_rating'], string> = {
    'Very Good': 'bg-emerald-600/20 text-emerald-800 border-emerald-600/40',
    'Good':      'bg-emerald-500/15 text-emerald-700 border-emerald-500/40',
    'Fair':      'bg-amber-500/15 text-amber-700 border-amber-500/40',
    'Bad':       'bg-orange-500/15 text-orange-700 border-orange-500/40',
    'Very Bad':  'bg-destructive/15 text-destructive border-destructive/40',
    'Starter':   'bg-violet-500/15 text-violet-700 border-violet-500/40',
  };

  const dailyLabel =
    cap.daily_rating === 'Starter' ? 'New today' : `Today: ${cap.daily_rating}`;
  // Agent-performance % — the SAME figure the badge is graded on: the share of
  // due tenants the agent got to pay. It is NOT the UGX percentage of the
  // expected daily book, so tenants paying less than their daily amount can no
  // longer drag the agent's rating down.
  const todayPct = Math.round((cap.performance_pct || 0) * 100);
  const cashPct = cap.expected_daily > 1
    ? Math.min(100, Math.round((cap.paid_today / cap.expected_daily) * 100))
    : 0;


  const canPost = cap.can_post_rent_today;

  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-xl bg-primary/15 flex items-center justify-center">
            <Gauge className="h-4 w-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-bold text-foreground">Your Rating</p>
            <p className="text-[11px] text-muted-foreground">
              {profile?.full_name || 'Agent'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${dailyRatingTone[cap.daily_rating]}`}
            title={`Your performance today — ${todayPct}% of due tenants paid (${cap.tenants_paid_today} of ${cap.tenants_due}). Amounts collected: ${formatUGX(cap.paid_today)}.`}
          >
            {dailyLabel}
          </span>
          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${tierTone[cap.tier]}`}
            title={`7-day response rate — ${Math.round(cap.response_rate * 100)}% (${cap.responding_tenant_days} of ${cap.expected_tenant_days} tenant-days)`}
          >
            7d: {cap.tier}
          </span>

          <Improve7DayRatingPopover capacity={cap} agentId={agentId} />
        </div>
      </div>

      {/* Progress bars */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-muted/50 p-2.5 space-y-1.5">
          <div className="flex items-center justify-between text-[10px] font-semibold text-muted-foreground">
            <span className="flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> Tenants reached today
            </span>
            <span className={todayPct >= 50 ? 'text-emerald-700' : todayPct >= 15 ? 'text-amber-700' : 'text-destructive'}>
              {todayPct}%
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full transition-all ${todayPct >= 50 ? 'bg-emerald-500' : todayPct >= 15 ? 'bg-amber-500' : 'bg-destructive'}`}
              style={{ width: `${Math.min(100, todayPct)}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground tabular-nums">
            {cap.tenants_paid_today}/{cap.tenants_due} tenants paid · {formatUGX(cap.paid_today)} collected
            {cashPct > 0 ? ` (${cashPct}% of target)` : ''}
          </p>

        </div>

        <div className="rounded-xl bg-muted/50 p-2.5 space-y-1.5">
          <div className="flex items-center justify-between text-[10px] font-semibold text-muted-foreground">
            <span className="flex items-center gap-1">
              <Gauge className="h-3 w-3" /> 7-Day Response
            </span>
            <span className={cap.response_rate >= 0.4 ? 'text-emerald-700' : cap.response_rate >= 1 ? 'text-amber-700' : 'text-destructive'}>
              {Math.round(cap.response_rate * 100)}%
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full transition-all ${
                cap.response_rate >= 0.7 ? 'bg-emerald-500' : cap.response_rate >= 0.4 ? 'bg-amber-500' : 'bg-destructive'
              }`}
              style={{ width: `${Math.min(100, Math.round(cap.response_rate * 100))}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground tabular-nums">
            {cap.responding_tenant_days} / {cap.expected_tenant_days} tenant-days
          </p>
        </div>
      </div>

      {!canPost && cap.active_count > 1 && (
        <div className="flex items-center gap-2 text-[11px] text-destructive bg-destructive/10 rounded-lg px-3 py-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>
            Collect from <strong>{Math.max(1, Math.ceil(cap.tenants_due * 0.5) - cap.tenants_paid_today)}</strong> more
            tenant{Math.max(1, Math.ceil(cap.tenants_due * 0.5) - cap.tenants_paid_today) === 1 ? '' : 's'} today to post new rent requests.
          </span>
        </div>
      )}
    </div>
  );
}

export default AgentRatingCard;
