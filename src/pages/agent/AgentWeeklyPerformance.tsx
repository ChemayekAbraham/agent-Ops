import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Activity, CheckCircle2, XCircle, CalendarClock, Target, Phone,
  ChevronDown, Info, RefreshCw, Hourglass, TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { useMyWeeklyPerformance } from '@/hooks/useMyWeeklyPerformance';
import { PerformanceCalendar } from '@/components/agent/PerformanceCalendar';
import {
  currentWeekProgress, judgedWeekProgress, nextResultDay, shortDay,
  type GroupProgress, type PerformancePlan, type PerformanceWeek,
} from '@/lib/weeklyPerformance';

/** Bar showing collected against what was due, with a line at the target. */
function TargetBar({ g, tone }: { g: GroupProgress; tone: 'current' | 'expired' }) {
  const fill = Math.round(g.ratio * 100);
  const mark = g.required === null ? null : Math.min(100, Math.round(g.required * 100));
  return (
    <div className="relative h-3 w-full rounded-full bg-muted overflow-visible">
      <div
        className={cn(
          'h-full rounded-full transition-all duration-500',
          g.met ? 'bg-success' : tone === 'current' ? 'bg-primary' : 'bg-amber-500',
        )}
        style={{ width: `${fill}%` }}
      />
      {mark !== null && (
        <div className="absolute -top-1 -bottom-1 w-0.5 bg-foreground/70 rounded" style={{ left: `${mark}%` }}>
          <span className="absolute -top-4 -translate-x-1/2 text-[9px] font-bold text-foreground/70">{mark}%</span>
        </div>
      )}
    </div>
  );
}

function GroupCard({
  title, subtitle, g, plans, tone, liveWeek, daysLeft,
}: {
  title: string; subtitle: string; g: GroupProgress; plans: number;
  tone: 'current' | 'expired'; liveWeek: boolean; daysLeft?: number;
}) {
  if (g.due <= 0) return null;
  const pct = g.due > 0 ? (g.collected / g.due) * 100 : 0;
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold leading-tight">{title}</p>
          <p className="text-[11px] text-muted-foreground leading-tight">{subtitle} · {plans} plan{plans === 1 ? '' : 's'}</p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold',
            g.met ? 'bg-success/15 text-success' : 'bg-destructive/10 text-destructive',
          )}
        >
          {g.met ? 'Target met' : `Needs ${Math.round((g.required ?? 0) * 100)}%`}
        </span>
      </div>
      <div className="pt-3">
        <TargetBar g={g} tone={tone} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-[10px] text-muted-foreground">Collected</p>
          <p className="text-sm font-bold">{formatUGX(g.collected)}</p>
          <p className="text-[10px] text-muted-foreground">{pct.toFixed(1)}%</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">{liveWeek ? 'Expected this week' : 'Was due'}</p>
          <p className="text-sm font-bold">{formatUGX(g.due)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">Target</p>
          <p className="text-sm font-bold">{formatUGX(g.target)}</p>
        </div>
      </div>
      {!g.met && (
        <p className={cn('text-[11px] font-semibold rounded-xl px-3 py-2', liveWeek ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive')}>
          {liveWeek
            ? `Collect ${formatUGX(g.remaining)} more on these plans by Wednesday${daysLeft !== undefined ? ` (${daysLeft + 1} day${daysLeft === 0 ? '' : 's'} left, about ${formatUGX(Math.ceil(g.remaining / (daysLeft + 1)))} a day)` : ''}.`
            : `Short by ${formatUGX(g.remaining)}.`}
        </p>
      )}
    </div>
  );
}

function PlanRow({ p }: { p: PerformancePlan }) {
  const left = Math.max(0, p.due_so_far - p.collected);
  const ratio = p.due_so_far > 0 ? Math.min(1, p.collected / p.due_so_far) : 0;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border/50 bg-card p-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-semibold truncate">{p.tenant_name}</p>
          <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold',
            p.expired ? 'bg-amber-500/15 text-amber-600' : 'bg-primary/10 text-primary')}>
            {p.expired ? 'Expired' : 'Current'}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full rounded-full bg-muted">
          <div className={cn('h-full rounded-full', ratio >= 1 ? 'bg-success' : p.expired ? 'bg-amber-500' : 'bg-primary')}
            style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {formatUGX(p.collected)} of {formatUGX(p.due_so_far)} so far
          {left > 0 ? ` · ${formatUGX(left)} unpaid` : ' · up to date'}
        </p>
      </div>
      {p.tenant_phone && (
        <a
          href={`tel:${p.tenant_phone}`}
          aria-label={`Call ${p.tenant_name}`}
          className="shrink-0 flex h-10 w-10 items-center justify-center rounded-full bg-success/10 text-success active:scale-95 transition"
        >
          <Phone className="h-4 w-4" />
        </a>
      )}
    </div>
  );
}

function HistoryRow({ w }: { w: PerformanceWeek }) {
  const j = judgedWeekProgress(w);
  const nothing = w.book === 'none';
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border/50 bg-card p-3">
      <div className={cn('shrink-0 flex h-9 w-9 items-center justify-center rounded-full',
        nothing ? 'bg-muted text-muted-foreground' : w.passes ? 'bg-success/15 text-success' : 'bg-destructive/10 text-destructive')}>
        {nothing ? <Hourglass className="h-4 w-4" /> : w.passes ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold leading-tight">
          {shortDay(w.week_start)} – {shortDay(w.week_end)}
          {w.is_judged && <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold text-primary">Decides this week</span>}
        </p>
        {nothing ? (
          <p className="text-[11px] text-muted-foreground">Nothing was due</p>
        ) : (
          <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
            {j.current.due > 0 && (
              <p>Current: <span className={cn('font-semibold', j.current.met ? 'text-success' : 'text-destructive')}>
                {((w.in_window_pct ?? 0) * 100).toFixed(1)}%</span> of {formatUGX(w.in_window_due)}</p>
            )}
            {j.expired.due > 0 && (
              <p>Expired: <span className={cn('font-semibold', j.expired.met ? 'text-success' : 'text-destructive')}>
                {((w.expired_pct ?? 0) * 100).toFixed(1)}%</span> of {formatUGX(w.expired_due)}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AgentWeeklyPerformancePage() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch, isFetching } = useMyWeeklyPerformance(6);
  const [showRules, setShowRules] = useState(false);
  const [planFilter, setPlanFilter] = useState<'all' | 'current' | 'expired'>('all');

  const judged = data?.weeks.find((w) => w.is_judged) ?? null;
  const live = useMemo(() => (data ? currentWeekProgress(data.current_week) : null), [data]);
  const judgedProg = judged ? judgedWeekProgress(judged) : null;
  const canPost = !data?.settings.enforced || !judged || judged.passes;
  const plans = (data?.plans ?? []).filter((p) =>
    planFilter === 'all' ? true : planFilter === 'expired' ? p.expired : !p.expired);
  const s = data?.settings;

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      <header className="sticky top-0 z-20 bg-background/90 backdrop-blur-md border-b border-border">
        <div className="mx-auto w-full max-w-md px-4 py-3 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/dashboard/agent')} aria-label="Back to dashboard" className="h-11 w-11 shrink-0 rounded-full">
            <ArrowLeft className="h-6 w-6" />
          </Button>
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <Activity className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold leading-tight truncate">Weekly Performance</h1>
              <p className="text-sm text-muted-foreground leading-tight">Thursday to Wednesday</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => refetch()} aria-label="Refresh" className="h-11 w-11 shrink-0 rounded-full">
            <RefreshCw className={cn('h-5 w-5', isFetching && 'animate-spin')} />
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-md flex-1 px-4 py-4 space-y-5 pb-10">
        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full rounded-2xl" />
            <Skeleton className="h-40 w-full rounded-2xl" />
            <Skeleton className="h-40 w-full rounded-2xl" />
          </div>
        )}

        {error && !isLoading && (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <p className="font-semibold text-destructive">Could not load your performance</p>
            <p className="text-muted-foreground mt-1">Check your connection and try again.</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>Try again</Button>
          </div>
        )}

        {data && (
          <>
            {/* Posting status hero */}
            <section
              className={cn(
                'rounded-3xl p-5 text-primary-foreground shadow-lg relative overflow-hidden bg-primary',
                !canPost && 'ring-2 ring-primary-foreground/25',
              )}
            >
              <div className="absolute -right-6 -top-6 h-28 w-28 rounded-full bg-primary-foreground/10" />
              <div className="absolute -right-2 bottom-0 h-16 w-16 rounded-full bg-primary-foreground/10" />
              <div className="relative flex items-start gap-3">
                {canPost ? <CheckCircle2 className="h-8 w-8 shrink-0" /> : <XCircle className="h-8 w-8 shrink-0" />}
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide opacity-90">This week</p>
                  <p className="text-xl font-extrabold leading-tight">
                    {canPost ? 'You can post new Rent Plans' : 'You cannot post new Rent Plans'}
                  </p>
                  {judged && (
                    <p className="mt-1 text-[12px] opacity-90">
                      Based on last week, {shortDay(judged.week_start)} – {shortDay(judged.week_end)}.
                    </p>
                  )}
                </div>
              </div>
              {!canPost && judged?.reason && (
                <p className="relative mt-3 rounded-2xl bg-primary-foreground/15 px-3 py-2 text-[12px] leading-snug">{judged.reason}</p>
              )}
              <div className="relative mt-3 flex items-center gap-2 text-[12px] opacity-95">
                <CalendarClock className="h-4 w-4 shrink-0" />
                <span>Next result on {nextResultDay(data.current_week.week_end)}, from this week's collections.</span>
              </div>
            </section>

            {/* This week so far */}
            {live && (
              <section className="space-y-3">
                <div className="flex items-end justify-between">
                  <div>
                    <h2 className="text-base font-bold flex items-center gap-1.5"><TrendingUp className="h-4 w-4 text-primary" /> This week so far</h2>
                    <p className="text-[11px] text-muted-foreground">
                      {shortDay(data.current_week.week_start)} – {shortDay(data.current_week.week_end)} · day {data.current_week.days_elapsed} of 7
                    </p>
                  </div>
                  {data.current_week.book !== 'none' && (
                    <span className={cn('rounded-full px-2.5 py-1 text-[10px] font-bold',
                      live.onTrack ? 'bg-success/15 text-success' : 'bg-amber-500/15 text-amber-600')}>
                      {live.onTrack ? 'On track' : 'Behind target'}
                    </span>
                  )}
                </div>
                {data.current_week.book === 'none' ? (
                  <div className="rounded-2xl border border-border/60 bg-card p-4 text-sm text-muted-foreground">
                    Nothing has been billed to your tenants this week yet.
                  </div>
                ) : (
                  <>
                    <GroupCard
                      title="Current Rent Plans"
                      subtitle="Still inside their repayment period"
                      g={live.current}
                      plans={data.current_week.in_window_plans}
                      tone="current"
                      liveWeek
                      daysLeft={data.current_week.days_left}
                    />
                    <GroupCard
                      title="Expired Rent Plans"
                      subtitle="Past their repayment period"
                      g={live.expired}
                      plans={data.current_week.expired_plans}
                      tone="expired"
                      liveWeek
                      daysLeft={data.current_week.days_left}
                    />
                    <p className="text-[10px] text-muted-foreground px-1">
                      "Expected this week" assumes each tenant billed today is billed the same amount every day until Wednesday.
                      Only the amount due counts for each tenant; paying more than due doesn't cover another tenant.
                    </p>
                  </>
                )}
              </section>
            )}

            {/* Last week (decides this week) */}
            {judged && judgedProg && judged.book !== 'none' && (
              <section className="space-y-3">
                <h2 className="text-base font-bold flex items-center gap-1.5"><Target className="h-4 w-4 text-primary" /> Last week's result</h2>
                <GroupCard title="Current Rent Plans" subtitle={`${shortDay(judged.week_start)} – ${shortDay(judged.week_end)}`}
                  g={judgedProg.current} plans={judged.in_window_plans} tone="current" liveWeek={false} />
                <GroupCard title="Expired Rent Plans" subtitle={`${shortDay(judged.week_start)} – ${shortDay(judged.week_end)}`}
                  g={judgedProg.expired} plans={judged.expired_plans} tone="expired" liveWeek={false} />
              </section>
            )}

            {/* This week's tenants */}
            {data.plans.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-bold">Your tenants this week</h2>
                  <span className="text-[11px] text-muted-foreground">{data.plans.length}</span>
                </div>
                <div className="flex gap-1.5">
                  {(['all', 'current', 'expired'] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setPlanFilter(f)}
                      className={cn('rounded-full px-3 py-1.5 text-xs font-semibold transition',
                        planFilter === f ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-muted-foreground')}
                    >
                      {f === 'all' ? 'All' : f === 'current' ? 'Current' : 'Expired'}
                    </button>
                  ))}
                </div>
                <div className="space-y-2">
                  {plans.map((p) => <PlanRow key={p.rent_request_id} p={p} />)}
                  {plans.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">No tenants in this group this week.</p>
                  )}
                </div>
              </section>
            )}

            {/* History as a calendar */}
            {data.weeks.length > 0 && (
              <PerformanceCalendar
                weeks={data.weeks}
                today={data.current_week.today}
                names={Object.fromEntries(data.plans.filter((p) => p.tenant_id).map((p) => [p.tenant_id as string, { name: p.tenant_name, phone: p.tenant_phone }]))}
              />
            )}

            {/* How it works */}
            {s && (
              <section className="rounded-2xl border border-border/60 bg-muted/30">
                <button onClick={() => setShowRules((v) => !v)} className="w-full flex items-center gap-2 p-4 text-left">
                  <Info className="h-4 w-4 text-primary shrink-0" />
                  <span className="flex-1 text-sm font-semibold">How the weekly target works</span>
                  <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', showRules && 'rotate-180')} />
                </button>
                {showRules && (
                  <div className="px-4 pb-4 space-y-2 text-[12px] text-muted-foreground leading-relaxed">
                    <p>Each week runs from <strong className="text-foreground">Thursday to Wednesday</strong>. Every Thursday morning your result for the week that just ended decides whether you can post new Rent Plans for the whole new week.</p>
                    <p><strong className="text-foreground">Current Rent Plans</strong> (still inside their repayment period): collect at least <strong className="text-foreground">{Math.round(s.in_window_required_pct * 100)}%</strong> of what they were due.</p>
                    <p><strong className="text-foreground">Expired Rent Plans</strong> (past their repayment period): if you also have current plans, collect at least <strong className="text-foreground">{Math.round(s.expired_required_pct * 100)}%</strong> of what the expired ones were due. If all your plans have expired, you need <strong className="text-foreground">{Math.round(s.all_expired_required_pct * 100)}%</strong>.</p>
                    <p>Each tenant counts only up to what they were due, so one tenant paying extra does not cover another who paid nothing. Visit every tenant.</p>                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
