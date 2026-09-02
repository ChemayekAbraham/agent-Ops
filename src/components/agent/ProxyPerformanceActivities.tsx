import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import {
  Banknote,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  ListChecks,
  PiggyBank,
  Wallet,
} from 'lucide-react';
import type { ProxyPvActivityKind, ProxyPvReport } from '@/hooks/useProxyAgentPerformance';
import { useProxyPvPendingFeed } from '@/hooks/useProxyAgentPerformance';
import { ProxyActivityDrilldownDialog } from '@/components/agent/ProxyActivityDrilldownDialog';

const money = (v: unknown) => formatDynamic(v);

type StatusFilter = 'all' | 'verified' | 'pending';
type KindFilter = 'all' | ProxyPvActivityKind;

const KIND_META: Record<ProxyPvActivityKind, { label: string; icon: typeof FileCheck2; iconClass: string }> = {
  commitments: { label: 'Commitments', icon: FileCheck2, iconClass: 'bg-success/10 text-success' },
  investment: { label: 'Investments', icon: PiggyBank, iconClass: 'bg-primary/10 text-primary' },
  topups: { label: 'Top-ups', icon: Wallet, iconClass: 'bg-warning/10 text-warning' },
};

interface ActivityEntry {
  key: string;
  day: string;
  /** ISO date of the posting, for the drilldown query. */
  rawDay: string;
  kind: ProxyPvActivityKind;
  icon: typeof FileCheck2;
  iconClass: string;
  title: string;
  /** What happened, in plain language. */
  detail: string;
  /** How it moved the score. */
  impact: string;
  pv: number;
  /** Scored (verified/paid) vs awaiting verification. */
  status: 'verified' | 'pending';
}

/**
 * "Activities" — explains which actions produced the agent's performance and
 * how each one affects the PV score. Derives its feed from the server-side
 * daily history; no extra queries, no client-side money math beyond what the
 * RPC already returned.
 */
export function ProxyPerformanceActivities({ report }: { report: ProxyPvReport }) {
  const [showAll, setShowAll] = useState(false);
  const [drill, setDrill] = useState<{ day: string; kind: ProxyPvActivityKind } | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const { rates } = report;
  const pendingFeed = useProxyPvPendingFeed(report.agent_id, report.period_month);

  const verifiedEntries = useMemo<ActivityEntry[]>(() => {
    const out: ActivityEntry[] = [];
    // daily arrives ascending; show newest first.
    for (const d of [...report.daily].reverse()) {
      const date = new Date(`${d.day}T00:00:00`);
      const dayLabel = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', weekday: 'short' });
      if (d.commitments > 0) {
        out.push({
          key: `${d.day}-c`,
          day: dayLabel,
          rawDay: d.day,
          kind: 'commitments',
          icon: FileCheck2,
          iconClass: 'bg-success/10 text-success',
          title: `${d.commitments} verified commitment${d.commitments === 1 ? '' : 's'}`,
          detail: `A promissory note you recorded was verified and activated by Partner Ops.`,
          impact: `Each verified commitment adds ${money(rates.commitment_pv)} PV.`,
          pv: d.commitment_pv,
          status: 'verified',
        });
      }
      if (d.new_investment > 0) {
        out.push({
          key: `${d.day}-i`,
          day: dayLabel,
          rawDay: d.day,
          kind: 'investment',
          icon: PiggyBank,
          iconClass: 'bg-primary/10 text-primary',
          title: `New partner investment — ${money(d.new_investment)}`,
          detail: `A new partner you brought in funded a portfolio, and the commission was paid.`,
          impact: `New investments add ${rates.investment_pct}% of the amount as PV.`,
          pv: d.investment_pv,
          status: 'verified',
        });
      }
      if (d.topups > 0) {
        out.push({
          key: `${d.day}-t`,
          day: dayLabel,
          rawDay: d.day,
          kind: 'topups',
          icon: Wallet,
          iconClass: 'bg-warning/10 text-warning',
          title: `Partner top-up — ${money(d.topups)}`,
          detail: `An existing partner added more money to their portfolio.`,
          impact: `Top-ups add ${rates.topup_pct}% of the amount as PV.`,
          pv: d.topup_pv,
          status: 'verified',
        });
      }
    }
    return out;
  }, [report.daily, rates]);

  const pendingEntries = useMemo<ActivityEntry[]>(() => {
    const items = pendingFeed.data?.items ?? [];
    return items.map((it, idx) => {
      const date = new Date(`${it.day}T00:00:00`);
      const meta = KIND_META[it.kind];
      return {
        key: `pending-${it.reference}-${idx}`,
        day: date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', weekday: 'short' }),
        rawDay: it.day,
        kind: it.kind,
        icon: meta.icon,
        iconClass: meta.iconClass,
        title: it.kind === 'commitments' ? `Commitment — ${it.label}` : `${it.label} — ${money(it.amount)}`,
        detail: `${it.gate}. Current status: ${it.status.replace(/_/g, ' ')}.`,
        impact: `Worth ${money(it.potential_pv)} PV once cleared.`,
        pv: it.potential_pv,
        status: 'pending' as const,
      };
    });
  }, [pendingFeed.data]);

  const entries = useMemo<ActivityEntry[]>(() => {
    const all = [...verifiedEntries, ...pendingEntries];
    return all.filter(
      (e) => (statusFilter === 'all' || e.status === statusFilter) && (kindFilter === 'all' || e.kind === kindFilter),
    );
  }, [verifiedEntries, pendingEntries, statusFilter, kindFilter]);

  const pendingCount = pendingEntries.length;
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
            <Badge variant="outline" className="ml-auto shrink-0 text-[10px]">
              {entries.length} action{entries.length === 1 ? '' : 's'}
            </Badge>
          </div>

          {/* Filters — fixed two rows so the list below never shifts */}
          <div className="space-y-1.5 pb-2">
            <div className="flex h-7 items-center gap-1.5 overflow-x-auto no-scrollbar">
              {([
                { id: 'all' as StatusFilter, label: 'All', count: verifiedEntries.length + pendingCount },
                { id: 'verified' as StatusFilter, label: 'Verified', count: verifiedEntries.length },
                { id: 'pending' as StatusFilter, label: 'Awaiting verification', count: pendingCount },
              ]).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => { setStatusFilter(f.id); setShowAll(false); }}
                  className={cn(
                    'shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold transition-colors',
                    statusFilter === f.id
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border/70 text-muted-foreground hover:bg-muted/60',
                  )}
                >
                  {f.label} ({f.count})
                </button>
              ))}
            </div>
            <div className="flex h-7 items-center gap-1.5 overflow-x-auto no-scrollbar">
              {([
                { id: 'all' as KindFilter, label: 'All types' },
                { id: 'commitments' as KindFilter, label: KIND_META.commitments.label },
                { id: 'investment' as KindFilter, label: KIND_META.investment.label },
                { id: 'topups' as KindFilter, label: KIND_META.topups.label },
              ]).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => { setKindFilter(f.id); setShowAll(false); }}
                  className={cn(
                    'shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold transition-colors',
                    kindFilter === f.id
                      ? 'border-foreground/30 bg-muted text-foreground'
                      : 'border-border/70 text-muted-foreground hover:bg-muted/60',
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-[120px]">
            {pendingFeed.isLoading && statusFilter !== 'verified' && entries.length === 0 ? (
              <div className="space-y-2 py-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/60" />
                ))}
              </div>
            ) : entries.length === 0 ? (
              <div className="flex items-start gap-3 rounded-xl border border-dashed border-border p-3">
                <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="space-y-0.5">
                  <p className="text-[11px] font-bold">
                    {statusFilter === 'pending'
                      ? 'Nothing awaiting verification'
                      : statusFilter === 'verified'
                        ? 'No verified activities yet'
                        : 'No activities match these filters'}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {statusFilter === 'pending'
                      ? 'Everything you have recorded this month has already been verified or paid.'
                      : 'Record a promissory note or bring in a partner investment — once verified or paid, it shows up here with the PV it earned.'}
                  </p>
                </div>
              </div>
            ) : (
              visible.map((e) => {
                const isPending = e.status === 'pending';
                return (
                  <button
                    key={e.key}
                    type="button"
                    disabled={isPending}
                    onClick={() => { if (!isPending) setDrill({ day: e.rawDay, kind: e.kind }); }}
                    className={cn(
                      'flex w-full items-start gap-3 border-b border-border/50 py-2.5 text-left last:border-0',
                      isPending ? 'cursor-default' : 'hover:bg-muted/40',
                    )}
                  >
                    <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', e.iconClass)}>
                      <e.icon className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-[11px] font-bold leading-snug">{e.title}</p>
                        <span
                          className={cn(
                            'shrink-0 text-[11px] font-black tabular-nums',
                            isPending ? 'text-muted-foreground' : 'text-success',
                          )}
                        >
                          {isPending ? money(e.pv) : `+${money(e.pv)}`} PV
                        </span>
                      </div>
                      <p className="text-[10px] text-muted-foreground leading-snug">{e.detail}</p>
                      <p className="text-[10px] text-muted-foreground/80 italic leading-snug">{e.impact}</p>
                      <p className="flex items-center gap-1 pt-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                        {isPending ? (
                          <>
                            <Clock3 className="h-3 w-3" />
                            {e.day} · not counted yet
                          </>
                        ) : (
                          <>
                            {e.day} · view transactions
                            <ChevronRight className="h-3 w-3" />
                          </>
                        )}
                      </p>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {entries.length > 8 && (
            <Button variant="ghost" size="sm" className="mt-1 w-full gap-1" onClick={() => setShowAll((v) => !v)}>
              {showAll ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {showAll ? 'Show less' : `Show all ${entries.length} activities`}
            </Button>
          )}
        </CardContent>
      </Card>

      <ProxyActivityDrilldownDialog
        open={!!drill}
        onOpenChange={(o) => { if (!o) setDrill(null); }}
        agentId={report.agent_id}
        day={drill?.day ?? null}
        kind={drill?.kind ?? null}
      />
    </div>
  );
}
