import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import { Activity, CalendarDays, ChevronDown, ChevronUp, Target, TrendingUp } from 'lucide-react';
import {
  PROXY_PV_BAND_META,
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
export function ProxyPerformanceSection({ agentId, month, hideHeading, className }: Props) {
  const [showAllDays, setShowAllDays] = useState(false);
  const q = useProxyAgentPv(agentId ?? null, month);
  const r = q.data;

  const days = useMemo(() => {
    const all = (r?.daily ?? []).slice().reverse();
    return showAllDays ? all : all.slice(0, 7);
  }, [r?.daily, showAllDays]);

  if (q.isLoading) return <Skeleton className={cn('h-64 rounded-2xl', className)} />;
  if (q.error) {
    return (
      <Card className={className}>
        <CardContent className="p-4 text-sm text-destructive">{(q.error as Error).message}</CardContent>
      </Card>
    );
  }
  if (!r) return null;

  const mtdPct = r.mtd.performance_pct;
  const meta = PROXY_PV_BAND_META[proxyPvBand(mtdPct)];

  return (
    <div className={cn('space-y-3', className)}>
      {!hideHeading && (
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-black">Performance Value (PV)</h2>
          <Badge variant="outline" className="ml-auto text-[10px]">
            {new Date(`${r.period_month}T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
          </Badge>
        </div>
      )}

      {/* MTD hero */}
      <Card className={cn('border-primary/30', meta.className.includes('destructive') && 'border-destructive/40')}>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Month-to-date PV
              </p>
              <p className="text-2xl font-black tabular-nums leading-tight break-words">{money(r.mtd.total_pv)}</p>
              <p className="text-[11px] text-muted-foreground">
                Expected by today {money(r.mtd.expected_pv)} · target {money(r.targets.monthly_pv_target)}
              </p>
            </div>
            <BandBadge pct={mtdPct} />
          </div>

          <Progress value={Math.min(r.mtd.monthly_performance_pct, 100)} className="h-2" />

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

      {/* Today */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Target className="h-4 w-4 text-primary shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Today's PV</p>
                <p className="text-xl font-black tabular-nums leading-tight">{money(r.today.total_pv)}</p>
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-[10px] text-muted-foreground">Daily target</p>
              <p className="text-xs font-bold tabular-nums">{money(r.today.target_pv)}</p>
              <div className="mt-1 flex justify-end">
                {r.today.is_working_day === false ? (
                  <span className="text-[10px] text-muted-foreground">Rest day</span>
                ) : (
                  <BandBadge pct={r.today.performance_pct} />
                )}
              </div>
            </div>

          </div>
          <div className="grid grid-cols-3 gap-2 pt-1">
            {[
              ['Commitments', `${r.today.commitments}`, money(r.today.commitment_pv)],
              [`New (${r.rates.investment_pct}%)`, money(r.today.new_investment), money(r.today.investment_pv)],
              [`Top-ups (${r.rates.topup_pct}%)`, money(r.today.topups), money(r.today.topup_pv)],
            ].map(([label, raw, pv]) => (
              <div key={label} className="rounded-xl border border-border/60 p-2 min-w-0">
                <p className="text-[10px] text-muted-foreground truncate">{label}</p>
                <p className="text-[11px] font-bold tabular-nums break-words">{raw}</p>
                <p className="text-[10px] text-primary font-semibold tabular-nums break-words">{pv} PV</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

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
        </CardContent>
      </Card>

      {/* Daily history */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 pb-1">
            <CalendarDays className="h-4 w-4 text-primary" />
            <p className="text-xs font-black">Daily history</p>
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
    </div>
  );
}
