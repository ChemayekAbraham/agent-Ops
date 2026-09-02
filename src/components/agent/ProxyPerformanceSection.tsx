import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import { Activity, AlertTriangle, CalendarDays, ChevronDown, ChevronUp, ClipboardCheck, Inbox, Sparkles, TrendingUp } from 'lucide-react';
import { ProxyPerformanceActivities } from '@/components/agent/ProxyPerformanceActivities';
import { ProxyPerformanceTrends } from '@/components/agent/ProxyPerformanceTrends';
import { ProxyPerformanceWhatChanged } from '@/components/agent/ProxyPerformanceWhatChanged';
import {
  PROXY_PV_BAND_META,
  monthStartISO,
  proxyPvBand,
  useProxyAgentPv,
  type ProxyPvDay,
} from '@/hooks/useProxyAgentPerformance';

const money = (v: unknown) => formatDynamic(v);

function BandBadge({ pct }: { pct: number }) {
  const meta = PROXY_PV_BAND_META[proxyPvBand(pct)];
  return (
    <Badge variant="outline" className={cn('gap-1 text-[10px] font-bold', meta.className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
      {pct}%
    </Badge>
  );
}

function DayRow({ d }: { d: ProxyPvDay }) {
  const date = new Date(`${d.day}T00:00:00`);
  const label = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', weekday: 'short' });
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0">
      <div className="min-w-0">
        <p className="text-xs font-semibold truncate">{label}</p>
        <p className="text-[10px] text-muted-foreground truncate">
          {d.commitments} commitment{d.commitments === 1 ? '' : 's'} · {money(d.new_investment)} new · {money(d.topups)} top-ups
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs font-black tabular-nums">{money(d.total_pv)}</p>
        <div className="mt-0.5 flex items-center justify-end gap-1">
          {d.is_working_day ? (
            <BandBadge pct={d.performance_pct} />
          ) : (
            <span className="text-[10px] text-muted-foreground">Rest day</span>
          )}
        </div>
      </div>
    </div>
  );
}

interface Props {
  /** Omit for the signed-in proxy agent; pass an id for an ops drill-down. */
  agentId?: string | null;
  month?: string;
  /** Hide the section heading when embedded in a panel that has its own title. */
  hideHeading?: boolean;
  className?: string;
}

/**
 * Performance Value (PV) tracker for a single proxy agent:
 * today's PV, month-to-date expected vs actual, and the daily history.
 */
export function ProxyPerformanceSection({ agentId, month: monthProp, hideHeading, className }: Props) {
  const [showAllDays, setShowAllDays] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [monthState, setMonthState] = useState(() => monthStartISO());
  const month = monthProp ?? monthState;
  const q = useProxyAgentPv(agentId ?? null, month);
  const r = q.data;

  const days = useMemo(() => {
    const all = (r?.daily ?? []).slice().reverse();
    return showAllDays ? all : all.slice(0, 7);
  }, [r?.daily, showAllDays]);

  if (q.isLoading) return <Skeleton className={cn('h-64 rounded-2xl', className)} />;
  if (q.error) {
    return (
      <Card className={cn('border-destructive/40', className)}>
        <CardContent className="flex items-start gap-3 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-bold">Performance data unavailable</p>
            <p className="text-xs text-muted-foreground break-words">{(q.error as Error).message}</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  if (!r) return null;

  const dq = r.data_quality;
  const noVerifiedActivity = r.mtd.total_pv === 0 && r.mtd.commitments === 0;
  const pendingCount = (dq?.pending_commitments ?? 0) + (dq?.unpaid_commission_events ?? 0);

  const mtdPct = r.mtd.performance_pct;
  const meta = PROXY_PV_BAND_META[proxyPvBand(mtdPct)];

  return (
    <div className={cn('space-y-3', className)}>
      {!hideHeading && (
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-black">Your Performance Score</h2>
          <Badge variant="outline" className="ml-auto text-[10px]">
            {new Date(`${r.period_month}T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
          </Badge>
        </div>
      )}

      {/* How you earn — three visual tiles, no reading required */}
      <Card className="border-primary/40 bg-primary/5">
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-black uppercase tracking-wider text-primary">How you earn</p>
            <p className="text-[10px] font-semibold text-muted-foreground">Goal: {money(r.targets.monthly_pv_target)}/mo</p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-background border border-primary/20 p-2.5 text-center">
              <ClipboardCheck className="mx-auto h-5 w-5 text-primary" />
              <p className="mt-1 text-sm font-black tabular-nums">{money(r.rates.commitment_pv)}</p>
              <p className="text-[9px] font-medium text-muted-foreground leading-tight">per verified deal</p>
            </div>
            <div className="rounded-xl bg-background border border-primary/20 p-2.5 text-center">
              <TrendingUp className="mx-auto h-5 w-5 text-primary" />
              <p className="mt-1 text-sm font-black tabular-nums">{r.rates.investment_pct}%</p>
              <p className="text-[9px] font-medium text-muted-foreground leading-tight">of new money</p>
            </div>
            <div className="rounded-xl bg-background border border-primary/20 p-2.5 text-center">
              <Sparkles className="mx-auto h-5 w-5 text-primary" />
              <p className="mt-1 text-sm font-black tabular-nums">{r.rates.topup_pct}%</p>
              <p className="text-[9px] font-medium text-muted-foreground leading-tight">of top-ups</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Ambiguous attribution warning — one line */}
      {dq && dq.is_approved_proxy === false && (
        <div className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3 py-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <p className="text-[11px] font-semibold">Some activity may be missing — your account isn't confirmed as a proxy yet.</p>
        </div>
      )}

      {/* No verified activity yet — one line */}
      {noVerifiedActivity && (
        <div className="flex items-center gap-2 rounded-xl border border-dashed px-3 py-2">
          <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-[11px] font-semibold text-muted-foreground">
            Nothing verified yet this month.
            {pendingCount > 0 && ` ${pendingCount} waiting for verification.`}
          </p>
        </div>
      )}

      {/* MTD hero */}
      <Card className={cn('border-primary/30', meta.className.includes('destructive') && 'border-destructive/40')}>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Your score so far this month
              </p>
              <p className="text-2xl font-black tabular-nums leading-tight break-words">{money(r.mtd.total_pv)}</p>
              <p className="text-[11px] text-muted-foreground">
                Expected by today {money(r.mtd.expected_pv)} · monthly goal {money(r.targets.monthly_pv_target)}
              </p>
            </div>
            <BandBadge pct={mtdPct} />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px]">
              <span className={cn('font-bold', r.mtd.monthly_performance_pct >= 100 && 'text-success')}>
                {r.mtd.monthly_performance_pct}% of your monthly goal
              </span>
              {r.mtd.monthly_performance_pct > 100 && (
                <span className="font-bold text-success">+{money(r.mtd.above_target)} above target</span>
              )}
            </div>
            <Progress
              value={Math.min(r.mtd.monthly_performance_pct, 100)}
              variant={r.mtd.monthly_performance_pct >= 100 ? 'success' : 'default'}
              className="h-2"
            />
          </div>

          {r.mtd.monthly_performance_pct > 100 && (
            <p className="text-[11px] font-semibold text-success">
              Target exceeded — {r.mtd.monthly_performance_pct}% achieved
            </p>
          )}

          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded-xl border border-border/60 p-2">
              <p className="text-muted-foreground">Remaining to target</p>
              <p className="font-black tabular-nums">{money(r.mtd.remaining_to_target)}</p>
            </div>
            <div className="rounded-xl border border-border/60 p-2">
              <p className="text-muted-foreground">Working days left</p>
              <p className="font-black tabular-nums">
                {r.targets.working_days_remaining} of {r.targets.working_days}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Today — giant number, color-coded, one glance */}
      {r.today.is_working_day === false ? (
        <Card>
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <p className="text-[11px] font-black uppercase tracking-wider text-muted-foreground">Today</p>
            <Badge variant="secondary">Rest day</Badge>
          </CardContent>
        </Card>
      ) : (
        <Card className={cn(
          r.today.performance_pct >= 100
            ? 'border-emerald-500/60 bg-emerald-50/60 dark:bg-emerald-950/30'
            : r.today.performance_pct >= 50
              ? 'border-primary/30'
              : 'border-red-300/60 bg-red-50/50 dark:bg-red-950/20',
        )}>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[11px] font-black uppercase tracking-wider text-muted-foreground">Today</p>
                <p className="mt-1 text-4xl font-black tabular-nums leading-none">{money(r.today.total_pv)}</p>
              </div>
              <div className="text-right shrink-0">
                <p className={cn(
                  'text-2xl font-black tabular-nums',
                  r.today.performance_pct >= 100 ? 'text-emerald-600' : r.today.performance_pct >= 50 ? 'text-primary' : 'text-red-600',
                )}>
                  {r.today.performance_pct}%
                </p>
                <p className="text-[10px] text-muted-foreground">of {money(r.today.target_pv)} goal</p>
              </div>
            </div>
            <Progress
              value={Math.min(r.today.performance_pct, 100)}
              variant={r.today.performance_pct >= 100 ? 'success' : 'default'}
              className="h-3"
            />
            <p className="text-center text-xs font-bold">
              {r.today.performance_pct >= 100
                ? '✓ Goal reached today'
                : `${money(Math.max(0, r.today.target_pv - r.today.total_pv))} to go`}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Everything else lives behind "More details" to keep the phone view light */}
      <Button
        variant="outline"
        className="w-full gap-2 font-semibold"
        onClick={() => { setShowMore((v) => !v); }}
        aria-expanded={showMore}
      >
        {showMore ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        {showMore ? 'Show less' : 'More details — breakdown, charts & history'}
      </Button>

      {showMore && (<>
      {/* MTD breakdown */}
      <Card>
        <CardContent className="p-4 space-y-1.5">
          <div className="flex items-center gap-2 pb-1">
            <TrendingUp className="h-4 w-4 text-primary" />
            <p className="text-xs font-black">Month-to-date breakdown</p>
          </div>
          {[
            [`Verified commitments (${r.mtd.commitments} × ${money(r.rates.commitment_pv)})`, money(r.mtd.commitment_pv)],
            [`New partner investments — ${money(r.mtd.new_investment)} × ${r.rates.investment_pct}%`, money(r.mtd.investment_pv)],
            [`Partner top-ups — ${money(r.mtd.topups)} × ${r.rates.topup_pct}%`, money(r.mtd.topup_pv)],
            ['Total PV', money(r.mtd.total_pv)],
          ].map(([k, v], i, arr) => (
            <div
              key={k}
              className={cn(
                'flex items-start justify-between gap-3 border-b border-border/50 pb-1.5 last:border-0',
                i === arr.length - 1 && 'pt-1 font-black',
              )}
            >
              <span className="text-[11px] text-muted-foreground">{k}</span>
              <span className="text-xs font-bold text-right break-words tabular-nums">{v}</span>
            </div>
          ))}
          {pendingCount > 0 && !noVerifiedActivity && (
            <p className="flex items-center gap-1.5 pt-1 text-[10px] font-semibold text-primary">
              <ClipboardCheck className="h-3 w-3 shrink-0" />
              +{pendingCount} item{pendingCount === 1 ? '' : 's'} awaiting verification — not counted yet.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Trends: daily vs monthly drilldown with month-range toggles */}
      <ProxyPerformanceTrends
        report={r}
        agentId={agentId ?? null}
        month={month}
        onMonthChange={setMonthState}
      />

      {/* Daily history */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 pb-1">
            <CalendarDays className="h-4 w-4 text-primary" />
            <p className="text-xs font-black">Daily history (working days)</p>
          </div>
          {days.length === 0 ? (
            <p className="py-3 text-[11px] text-muted-foreground">No PV recorded this month yet.</p>
          ) : (
            days.map((d) => <DayRow key={d.day} d={d} />)
          )}
          {(r.daily?.length ?? 0) > 7 && (
            <Button variant="ghost" size="sm" className="mt-1 w-full gap-1" onClick={() => setShowAllDays((v) => !v)}>
              {showAllDays ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {showAllDays ? 'Show less' : `Show all ${r.daily.length} days`}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* What changed since yesterday, and which activities moved it */}
      <ProxyPerformanceWhatChanged report={r} />

      {/* Activities: which actions produced the PV and how each affects the score */}
      <ProxyPerformanceActivities report={r} />
      </>)}
    </div>
  );
}
