import { useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useAgentCapacityMap, type AgentCapacity } from '@/hooks/useAgentCapacityMap';
import { formatUGX } from '@/lib/rentCalculations';
import { CalendarCheck2, CheckCircle2, Lock, Loader2 } from 'lucide-react';

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
 * Answers one question fast: "How am I doing on collections TODAY,
 * and can I still post new rent requests?"
 */
export function AgentDailyCapacityStrip() {
  const { user } = useAuth();
  const ids = useMemo(() => (user?.id ? [user.id] : []), [user?.id]);
  const { data, isLoading } = useAgentCapacityMap(ids);
  const cap = user?.id ? data?.get(user.id) : undefined;

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

  const todayPct = cap.expected_daily > 0
    ? Math.min(100, Math.round((cap.paid_today / cap.expected_daily) * 100))
    : 0;
  const barTone = todayPct >= 50 ? 'bg-emerald-500' : todayPct >= 20 ? 'bg-amber-500' : 'bg-destructive';
  const canPost = cap.can_post_rent_today;
  const remaining = Math.max(0, cap.expected_daily - cap.paid_today);

  return (
    <div className="rounded-2xl border-2 border-border/60 bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="h-10 w-10 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
            <CalendarCheck2 className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-bold text-foreground">Today&apos;s capacity</p>
            <p className="text-xs text-muted-foreground">Collect daily to keep posting rents</p>
          </div>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-xs font-extrabold border shrink-0 ${RATING_TONE[cap.daily_rating]}`}>
          {cap.daily_rating}
        </span>
      </div>

      <div>
        <div className="flex items-center justify-between text-sm font-bold tabular-nums mb-1.5">
          <span className="text-foreground">{formatUGX(cap.paid_today)}</span>
          <span className="text-muted-foreground">of {formatUGX(cap.expected_daily)}</span>
        </div>
        <div className="h-3 w-full rounded-full bg-muted overflow-hidden">
          <div className={`h-full ${barTone} transition-all`} style={{ width: `${todayPct}%` }} />
        </div>
        <div className="flex items-center justify-between gap-2 mt-1.5">
          <p className="text-xs text-muted-foreground">
            {todayPct}% of today&apos;s target
            {remaining > 0 && <> · <strong className="text-foreground">{formatUGX(remaining)}</strong> to go</>}
          </p>
          <p className="text-xs font-semibold text-muted-foreground shrink-0 tabular-nums">
            {new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
          </p>
        </div>
      </div>

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
            <span>You can post new rent requests today</span>
          </>
        ) : (
          <>
            <Lock className="h-4 w-4 shrink-0" />
            <span>
              Collect <strong>{formatUGX(Math.max(0, Math.round(cap.expected_daily * 0.2) - cap.paid_today))}</strong> more today to unlock new rents
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export default AgentDailyCapacityStrip;