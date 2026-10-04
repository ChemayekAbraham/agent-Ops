import { useEffect, useState } from 'react';
import { Target, CalendarCheck, TrendingUp } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useRentAccessLimitParams } from '@/hooks/useRentAccessLimitParams';
import { formatUGX } from '@/lib/rentCalculations';
import { Progress } from '@/components/ui/progress';

interface Props {
  userId: string;
}

interface TrackerState {
  currentLimit: number | null;
  dailyTarget: number | null;
  paidToday: number;
}

/**
 * Rent access progress tracker on the tenant dashboard: shows the tenant's
 * current rent access limit, today's daily payment progress, and how far
 * they are from the programme maximum (UGX 30,000,000).
 */
export function RentAccessProgressTracker({ userId }: Props) {
  const { params } = useRentAccessLimitParams();
  const [state, setState] = useState<TrackerState>({ currentLimit: null, dailyTarget: null, paidToday: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Kampala day bounds for "paid today"
        const kampalaToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Kampala' });
        const dayStart = new Date(`${kampalaToday}T00:00:00+03:00`).toISOString();
        const dayEnd = new Date(`${kampalaToday}T23:59:59.999+03:00`).toISOString();

        const [limitRes, planRes, payRes] = await Promise.all([
          supabase
            .from('credit_access_limits')
            .select('total_limit')
            .eq('user_id', userId)
            .maybeSingle(),
          supabase
            .from('rent_requests')
            .select('daily_repayment')
            .eq('tenant_id', userId)
            .in('status', ['funded', 'repaying'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from('repayments')
            .select('amount')
            .eq('tenant_id', userId)
            .gte('created_at', dayStart)
            .lte('created_at', dayEnd),
        ]);

        if (cancelled) return;
        const paidToday = (payRes.data ?? []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
        setState({
          currentLimit: limitRes.data?.total_limit != null ? Number(limitRes.data.total_limit) : null,
          dailyTarget: planRes.data?.daily_repayment != null ? Number(planRes.data.daily_repayment) : null,
          paidToday,
        });
      } catch (e) {
        console.error('[RentAccessProgressTracker] load failed:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  if (loading) {
    return (
      <section aria-label="Rent access progress" className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="h-4 w-40 animate-pulse rounded bg-muted" />
        <div className="mt-3 h-2.5 w-full animate-pulse rounded-full bg-muted" />
        <div className="mt-3 h-3 w-56 animate-pulse rounded bg-muted" />
      </section>
    );
  }

  const max = params.max_limit_ugx;
  const current = state.currentLimit ?? 0;
  const pctOfMax = max > 0 ? Math.min(100, (current / max) * 100) : 0;
  const toGo = Math.max(0, max - current);

  const dailyTarget = state.dailyTarget ?? 0;
  const paidToday = state.paidToday;
  const dailyPct = dailyTarget > 0 ? Math.min(100, (paidToday / dailyTarget) * 100) : 0;
  const dayDone = dailyTarget > 0 && paidToday >= dailyTarget;

  return (
    <section
      aria-label="Rent access progress"
      className="animate-fade-in space-y-4 rounded-2xl border border-border bg-card p-4 shadow-sm"
    >
      {/* Current limit vs maximum */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Target className="h-3.5 w-3.5 text-primary" />
            Your rent access limit
          </p>
          <p className="text-xs text-muted-foreground">Max {formatUGX(max)}</p>
        </div>
        <p className="text-2xl font-bold leading-none text-foreground">
          {state.currentLimit != null ? formatUGX(current) : 'Not set yet'}
        </p>
        <Progress value={pctOfMax} className="h-2.5" />
        <p className="text-xs text-muted-foreground">
          {state.currentLimit != null
            ? toGo > 0
              ? `${formatUGX(toGo)} to go to reach ${formatUGX(max)}`
              : `You have reached the maximum of ${formatUGX(max)}`
            : 'Pay daily to set and grow your limit'}
        </p>
      </div>

      {/* Today's daily payment progress */}
      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <CalendarCheck className="h-3.5 w-3.5 text-primary" />
            Today's payment
          </p>
          {dailyTarget > 0 && (
            <p className={`text-xs font-medium ${dayDone ? 'text-primary' : 'text-muted-foreground'}`}>
              {dayDone ? 'Done for today' : `${formatUGX(Math.max(0, dailyTarget - paidToday))} left`}
            </p>
          )}
        </div>
        {dailyTarget > 0 ? (
          <>
            <Progress value={dailyPct} className="h-2.5" />
            <p className="text-xs text-muted-foreground">
              Paid {formatUGX(paidToday)} of {formatUGX(dailyTarget)} today
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            No active rent plan yet — once funded, your daily target appears here.
          </p>
        )}
      </div>

      {/* Growth hint */}
      <p className="flex items-center gap-1.5 rounded-xl bg-primary/10 px-3 py-2 text-xs font-medium text-foreground">
        <TrendingUp className="h-3.5 w-3.5 shrink-0 text-primary" />
        Every day you pay adds +{formatUGX(params.paid_increment_ugx)} to your rent access limit.
      </p>
    </section>
  );
}
