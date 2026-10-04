import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  FileCheck2,
  History,
  PiggyBank,
  Wallet,
} from 'lucide-react';
import type { ProxyPvActivityKind, ProxyPvDay, ProxyPvReport } from '@/hooks/useProxyAgentPerformance';
import { ProxyActivityDrilldownDialog } from '@/components/agent/ProxyActivityDrilldownDialog';

const money = (v: unknown) => formatDynamic(v);

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', weekday: 'short' });

interface KindLine {
  kind: ProxyPvActivityKind;
  icon: typeof FileCheck2;
  iconClass: string;
  label: string;
  todayPv: number;
  prevPv: number;
  delta: number;
  /** Plain-language cause of the movement. */
  reason: string;
}

/**
 * "What changed" — compares today's PV against the previous recorded day and
 * explains which activities moved the score up or down. Purely presentational:
 * every figure comes from the server-side daily history already on the report.
 */
export function ProxyPerformanceWhatChanged({ report }: { report: ProxyPvReport }) {
  const [drill, setDrill] = useState<{ day: string; kind: ProxyPvActivityKind } | null>(null);

  const model = useMemo(() => {
    const daily = report.daily ?? [];
    const todayIso = report.today?.date;
    const todayRow: ProxyPvDay | undefined =
      daily.find((d) => d.day === todayIso) ??
      (daily.length > 0 ? daily[daily.length - 1] : undefined);
    if (!todayRow) return null;

    const idx = daily.findIndex((d) => d.day === todayRow.day);
    const prevRow: ProxyPvDay | undefined = idx > 0 ? daily[idx - 1] : undefined;

    const prev = {
      day: prevRow?.day ?? null,
      total_pv: prevRow?.total_pv ?? 0,
      commitment_pv: prevRow?.commitment_pv ?? 0,
      investment_pv: prevRow?.investment_pv ?? 0,
      topup_pv: prevRow?.topup_pv ?? 0,
      commitments: prevRow?.commitments ?? 0,
      new_investment: prevRow?.new_investment ?? 0,
      topups: prevRow?.topups ?? 0,
    };

    const lines: KindLine[] = [
      {
        kind: 'commitments',
        icon: FileCheck2,
        iconClass: 'bg-success/10 text-success',
        label: 'Verified commitments',
        todayPv: todayRow.commitment_pv,
        prevPv: prev.commitment_pv,
        delta: todayRow.commitment_pv - prev.commitment_pv,
        reason: describeCount(todayRow.commitments, prev.commitments, 'verified commitment'),
      },
      {
        kind: 'investment',
        icon: PiggyBank,
        iconClass: 'bg-primary/10 text-primary',
        label: 'New partner investments',
        todayPv: todayRow.investment_pv,
        prevPv: prev.investment_pv,
        delta: todayRow.investment_pv - prev.investment_pv,
        reason: describeAmount(todayRow.new_investment, prev.new_investment, 'new investment'),
      },
      {
        kind: 'topups',
        icon: Wallet,
        iconClass: 'bg-warning/10 text-warning',
        label: 'Partner top-ups',
        todayPv: todayRow.topup_pv,
        prevPv: prev.topup_pv,
        delta: todayRow.topup_pv - prev.topup_pv,
        reason: describeAmount(todayRow.topups, prev.topups, 'top-up'),
      },
    ];

    const delta = todayRow.total_pv - prev.total_pv;
    const movers = lines.filter((l) => Math.abs(l.delta) > 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    let headline: string;
    if (!prevRow) {
      headline = `First recorded day this month — ${money(todayRow.total_pv)} PV so far, with nothing to compare against yet.`;
    } else if (delta > 0) {
      headline = `Up ${money(delta)} PV on ${dayLabel(prevRow.day)}${
        movers[0] ? `, mostly from ${movers[0].label.toLowerCase()}` : ''
      }.`;
    } else if (delta < 0) {
      headline = `Down ${money(Math.abs(delta))} PV on ${dayLabel(prevRow.day)}${
        movers[0] ? `, mainly because ${movers[0].label.toLowerCase()} dropped` : ''
      }.`;
    } else if (todayRow.total_pv === 0) {
      headline = `No PV recorded today or on ${dayLabel(prevRow.day)} — nothing has moved the score.`;
    } else {
      headline = `Level with ${dayLabel(prevRow.day)} at ${money(todayRow.total_pv)} PV.`;
    }

    return { todayRow, prevRow, prev, lines, movers, delta, headline };
  }, [report.daily, report.today?.date]);

  if (!model) return null;

  const { todayRow, prevRow, lines, movers, delta, headline } = model;
  const Trend = delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : ArrowRight;
  const trendClass = delta > 0 ? 'text-success' : delta < 0 ? 'text-destructive' : 'text-muted-foreground';

  return (
    <>
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-primary" />
              <div>
                <p className="text-xs font-black">What changed</p>
                <p className="text-[10px] text-muted-foreground">
                  {dayLabel(todayRow.day)} vs {prevRow ? dayLabel(prevRow.day) : 'no earlier day'}
                </p>
              </div>
            </div>
            <Badge variant="outline" className={cn('gap-1 text-[10px] font-bold', trendClass)}>
              <Trend className="h-3 w-3" />
              {delta === 0 ? 'No change' : `${delta > 0 ? '+' : '−'}${money(Math.abs(delta))} PV`}
            </Badge>
          </div>

          <p className="text-xs font-semibold leading-snug break-words">{headline}</p>

          <div className="grid grid-cols-2 gap-2">
            <Stat label={dayLabel(todayRow.day)} value={`${money(todayRow.total_pv)} PV`} />
            <Stat
              label={prevRow ? dayLabel(prevRow.day) : 'Previous day'}
              value={prevRow ? `${money(prevRow.total_pv)} PV` : 'No data'}
              muted
            />
          </div>

          <div className="space-y-1.5">
            {lines.map((l) => {
              const Icon = l.icon;
              const up = l.delta > 0;
              const down = l.delta < 0;
              return (
                <button
                  key={l.kind}
                  type="button"
                  onClick={() => setDrill({ day: todayRow.day, kind: l.kind })}
                  className="flex w-full items-start gap-2.5 rounded-lg border border-border/60 p-2.5 text-left hover:bg-muted/40"
                >
                  <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-full', l.iconClass)}>
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-[11px] font-bold">{l.label}</p>
                      <span
                        className={cn(
                          'shrink-0 text-[11px] font-black tabular-nums',
                          up ? 'text-success' : down ? 'text-destructive' : 'text-muted-foreground',
                        )}
                      >
                        {l.delta === 0 ? '0' : `${up ? '+' : '−'}${money(Math.abs(l.delta))}`} PV
                      </span>
                    </div>
                    <p className="text-[10px] leading-snug text-muted-foreground break-words">{l.reason}</p>
                    <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      {money(l.prevPv)} → {money(l.todayPv)} PV · view transactions
                      <ChevronRight className="h-3 w-3" />
                    </p>
                  </div>
                </button>
              );
            })}
          </div>

          {movers.length === 0 && prevRow && (
            <p className="text-[10px] text-muted-foreground">
              No activity type moved — the score is unchanged since {dayLabel(prevRow.day)}.
            </p>
          )}
        </CardContent>
      </Card>

      <ProxyActivityDrilldownDialog
        open={!!drill}
        onOpenChange={(o) => {
          if (!o) setDrill(null);
        }}
        agentId={report.agent_id}
        day={drill?.day ?? null}
        kind={drill?.kind ?? null}
      />
    </>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={cn('rounded-lg border border-border/60 p-2', muted && 'bg-muted/30')}>
      <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm font-black tabular-nums">{value}</p>
    </div>
  );
}

function describeCount(today: number, prev: number, noun: string) {
  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (today > prev) return `${plural(today)} verified today against ${plural(prev)} the day before.`;
  if (today < prev) return `Only ${plural(today)} verified today, down from ${plural(prev)}.`;
  if (today === 0) return `No ${noun}s verified on either day.`;
  return `Same as the day before — ${plural(today)}.`;
}

function describeAmount(today: number, prev: number, noun: string) {
  if (today > prev) return `${money(today)} in ${noun}s today against ${money(prev)} the day before.`;
  if (today < prev) return `${money(today)} in ${noun}s today, down from ${money(prev)}.`;
  if (today === 0) return `No ${noun}s recorded on either day.`;
  return `Same as the day before — ${money(today)}.`;
}
