import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import {
  Banknote,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  FileCheck2,
  ListChecks,
  PiggyBank,
  Wallet,
} from 'lucide-react';
import type { ProxyPvReport } from '@/hooks/useProxyAgentPerformance';

const money = (v: unknown) => formatDynamic(v);

interface ActivityEntry {
  key: string;
  day: string;
  icon: typeof FileCheck2;
  iconClass: string;
  title: string;
  /** What happened, in plain language. */
  detail: string;
  /** How it moved the score. */
  impact: string;
  pv: number;
}

/**
 * "Activities" — explains which actions produced the agent's performance and
 * how each one affects the PV score. Derives its feed from the server-side
 * daily history; no extra queries, no client-side money math beyond what the
 * RPC already returned.
 */
export function ProxyPerformanceActivities({ report }: { report: ProxyPvReport }) {
  const [showAll, setShowAll] = useState(false);
  const { rates } = report;

  const entries = useMemo<ActivityEntry[]>(() => {
    const out: ActivityEntry[] = [];
    // daily arrives ascending; show newest first.
    for (const d of [...report.daily].reverse()) {
      const date = new Date(`${d.day}T00:00:00`);
      const dayLabel = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', weekday: 'short' });
      if (d.commitments > 0) {
        out.push({
          key: `${d.day}-c`,
          day: dayLabel,
          icon: FileCheck2,
          iconClass: 'bg-success/10 text-success',
          title: `${d.commitments} verified commitment${d.commitments === 1 ? '' : 's'}`,
          detail: `A promissory note you recorded was verified and activated by Partner Ops.`,
          impact: `Each verified commitment adds ${money(rates.commitment_pv)} PV.`,
          pv: d.commitment_pv,
        });
      }
      if (d.new_investment > 0) {
        out.push({
          key: `${d.day}-i`,
          day: dayLabel,
          icon: PiggyBank,
          iconClass: 'bg-primary/10 text-primary',
          title: `New partner investment — ${money(d.new_investment)}`,
          detail: `A new partner you brought in funded a portfolio, and the commission was paid.`,
          impact: `New investments add ${rates.investment_pct}% of the amount as PV.`,
          pv: d.investment_pv,
        });
      }
      if (d.topups > 0) {
        out.push({
          key: `${d.day}-t`,
          day: dayLabel,
          icon: Wallet,
          iconClass: 'bg-warning/10 text-warning',
          title: `Partner top-up — ${money(d.topups)}`,
          detail: `An existing partner added more money to their portfolio.`,
          impact: `Top-ups add ${rates.topup_pct}% of the amount as PV.`,
          pv: d.topup_pv,
        });
      }
    }
    return out;
  }, [report.daily, rates]);

  const visible = showAll ? entries : entries.slice(0, 8);

  return (
    <div className="space-y-3">
      {/* How each action affects the score */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-primary" />
            <p className="text-xs font-black">What builds your PV</p>
          </div>
          <div className="space-y-2">
            {[
              {
                icon: FileCheck2,
                cls: 'bg-success/10 text-success',
                title: 'Verified commitments',
                text: `Record a promissory note and get it verified by Partner Ops. Each one adds ${money(rates.commitment_pv)} PV.`,
                chip: `+${money(rates.commitment_pv)} PV each`,
              },
              {
                icon: PiggyBank,
                cls: 'bg-primary/10 text-primary',
                title: 'New partner investments',
                text: `Bring in a new partner who funds a portfolio. You earn ${rates.investment_pct}% of the amount as PV once the commission is paid.`,
                chip: `+${rates.investment_pct}% of amount`,
              },
              {
                icon: Wallet,
                cls: 'bg-warning/10 text-warning',
                title: 'Partner top-ups',
                text: `When a partner you manage adds funds to their portfolio, you earn ${rates.topup_pct}% of the top-up as PV.`,
                chip: `+${rates.topup_pct}% of amount`,
              },
            ].map((a) => (
              <div key={a.title} className="flex items-start gap-3 rounded-xl border border-border/60 p-2.5">
                <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', a.cls)}>
                  <a.icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-bold truncate">{a.title}</p>
                    <Badge variant="outline" className="shrink-0 text-[9px] font-bold">{a.chip}</Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-snug">{a.text}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Only <span className="font-semibold">verified</span> commitments and{' '}
            <span className="font-semibold">paid</span> commissions count — pending items appear here once confirmed.
            Monthly target: {money(report.targets.monthly_pv_target)} PV across {report.targets.working_days} working
            days ({money(report.targets.daily_pv_target)} PV per working day).
          </p>
        </CardContent>
      </Card>

      {/* Activity feed */}
      <Card>
        <CardContent className="p-4 space-y-1">
          <div className="flex items-center gap-2 pb-1">
            <Banknote className="h-4 w-4 text-primary" />
            <p className="text-xs font-black">Your activities this month</p>
            {entries.length > 0 && (
              <Badge variant="outline" className="ml-auto text-[10px]">
                {entries.length} action{entries.length === 1 ? '' : 's'}
              </Badge>
            )}
          </div>

          {entries.length === 0 ? (
            <div className="flex items-start gap-3 rounded-xl border border-dashed border-border p-3">
              <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="space-y-0.5">
                <p className="text-[11px] font-bold">No scored activities yet</p>
                <p className="text-[10px] text-muted-foreground">
                  Record a promissory note or bring in a partner investment — once verified or paid, it shows up here
                  with the PV it earned.
                </p>
              </div>
            </div>
          ) : (
            visible.map((e) => (
              <div key={e.key} className="flex items-start gap-3 border-b border-border/50 py-2.5 last:border-0">
                <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', e.iconClass)}>
                  <e.icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[11px] font-bold leading-snug">{e.title}</p>
                    <span className="shrink-0 text-[11px] font-black tabular-nums text-success">
                      +{money(e.pv)} PV
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-snug">{e.detail}</p>
                  <p className="text-[10px] text-muted-foreground/80 italic leading-snug">{e.impact}</p>
                  <p className="pt-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {e.day}
                  </p>
                </div>
              </div>
            ))
          )}

          {entries.length > 8 && (
            <Button variant="ghost" size="sm" className="mt-1 w-full gap-1" onClick={() => setShowAll((v) => !v)}>
              {showAll ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {showAll ? 'Show less' : `Show all ${entries.length} activities`}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
