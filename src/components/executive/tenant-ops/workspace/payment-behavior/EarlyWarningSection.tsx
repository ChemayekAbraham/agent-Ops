import { useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContactActions } from '@/components/ops/ContactActions';
import {
  usePaymentBehaviorWatchlist, type PaymentBehaviorFilters, type WarningFlag, type WatchlistRow,
} from '@/hooks/tenantOpsWorkspace/usePaymentBehavior';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { FLAG_HINT, FLAG_LABEL, fmtDay, num, pct, ugx } from './labels';
import { Callout, ChartSkeleton, EstimateBadge, ObservedBadge, SectionCard, StatTile } from './shared';
import { cn } from '@/lib/utils';

const FLAGS: WarningFlag[] = ['silent', 'behind', 'slipping', 'moving_to_agent', 'refused_attempt'];
const PAGE = 20;
const MIN_OPTIONS = [{ v: 1, label: 'Any sign' }, { v: 2, label: '2+ signs' }, { v: 3, label: '3+ signs' }];

function ScoreBadge({ score }: { score: number }) {
  const cls = score >= 3 ? 'bg-destructive text-destructive-foreground' : score === 2 ? 'bg-warning text-warning-foreground' : 'bg-muted text-foreground';
  return <span className={cn('inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-xs font-bold tabular-nums', cls)} aria-label={`${score} warning signs`}>{score}</span>;
}

function WatchRow({ r }: { r: WatchlistRow }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-3 shadow-sm" data-testid="watch-row">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{r.tenant_name}</p>
          <p className="text-[11px] text-muted-foreground">
            Rent Plan {r.plan_code}{r.district ? ` · ${r.district}` : ''} · Agent {r.agent_name}
          </p>
        </div>
        <ScoreBadge score={r.score} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {r.flags.map((f) => (
          <span key={f} title={FLAG_HINT[f]} className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-foreground">{FLAG_LABEL[f]}</span>
        ))}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] sm:grid-cols-4">
        <div><dt className="text-muted-foreground">Last paid</dt><dd className="font-semibold">{r.last_paid_day ? fmtDay(r.last_paid_day) : 'Not in 28 days'}{r.days_since_payment !== null ? ` (${r.days_since_payment}d)` : ''}</dd></div>
        <div><dt className="text-muted-foreground">Days behind</dt><dd className="font-semibold tabular-nums">{r.days_behind ?? '—'}</dd></div>
        <div><dt className="text-muted-foreground">Paid, last 7 days</dt><dd className="font-semibold tabular-nums">{ugx(r.paid_7d_ugx)} of {ugx(r.billed_7d_ugx)}</dd></div>
        <div><dt className="text-muted-foreground">Paid, 7 days before</dt><dd className="font-semibold tabular-nums">{ugx(r.paid_prev_7d_ugx)} of {ugx(r.billed_prev_7d_ugx)}</dd></div>
      </dl>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Tenant</span>
          <ContactActions phone={r.tenant_phone} showLabels message={`Hello ${r.tenant_name}, this is Welile Ops about your Rent Plan ${r.plan_code}.`} />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Agent</span>
          <ContactActions phone={r.agent_phone} showLabels message={`Hello ${r.agent_name}, this is Welile Ops about Rent Plan ${r.plan_code} (${r.tenant_name}).`} />
        </div>
      </div>
    </div>
  );
}

export function EarlyWarningSection({ filters }: { filters: PaymentBehaviorFilters }) {
  const [minScore, setMinScore] = useState(2);
  const [page, setPage] = useState(0);
  const { data, isLoading, isError, isFetching } = usePaymentBehaviorWatchlist(filters, { minScore, limit: PAGE, offset: page * PAGE });
  const sum = data?.summary;
  const bt = data?.backtest;
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE));

  return (
    <div className="space-y-3">
      <SectionCard
        title="Early-warning signs"
        description={data ? `Live Rent Plans as at ${fmtDay(data.asof)}. A plan scores one point for each sign that applies.` : 'Rent Plans scored on five warning signs.'}
        badge={<ObservedBadge />}
      >
        {isLoading || !data ? <ChartSkeleton h={140} /> : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
              <StatTile label="Rent Plans scored" value={num(sum?.plans_scored)} />
              <StatTile label="No signs" tone="success" value={num(sum?.score_0)} />
              <StatTile label="1 sign" tone="warning" value={num(sum?.score_1)} />
              <StatTile label="2 or more signs" tone="destructive" value={num((sum?.score_2 ?? 0) + (sum?.score_3_plus ?? 0))} sub={`${num(sum?.score_3_plus)} with 3+`} />
            </div>
            <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 xl:grid-cols-5">
              {FLAGS.map((f) => (
                <div key={f} className="rounded-xl border border-border/60 bg-card p-2.5">
                  <p className="text-lg font-bold tabular-nums">{num(sum?.by_flag[f])}</p>
                  <p className="text-xs font-semibold">{FLAG_LABEL[f]}</p>
                  <p className="text-[11px] leading-snug text-muted-foreground">{FLAG_HINT[f]}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Have these signs predicted missed payments?"
        description={bt ? `Signs as they stood on ${fmtDay(bt.cutoff_day)}, against what happened ${fmtDay(bt.outcome_window.start_day)} to ${fmtDay(bt.outcome_window.end_day)}. Missed = billed in that week and under half of it paid.` : undefined}
        badge={<EstimateBadge label="Back-test" />}
      >
        {isLoading || !bt ? <ChartSkeleton h={140} /> : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <StatTile label="No signs missed" tone="success" value={pct(bt.no_signs_missed_pct)} sub={`${num(bt.no_signs_plans)} plans`} />
              <StatTile label="2+ signs missed" tone="destructive" value={pct(bt.two_plus_signs_missed_pct)} sub={`${num(bt.two_plus_signs_plans)} plans`} />
              <StatTile label="All plans missed" value={pct(bt.missed_pct)} sub={`${num(bt.plans)} plans`} />
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[420px] text-xs">
                <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr><th className="px-3 py-2">Sign</th><th className="px-3 py-2 text-right">Had it</th><th className="px-3 py-2 text-right">Missed</th><th className="px-3 py-2 text-right">Did not have it</th><th className="px-3 py-2 text-right">Missed</th></tr>
                </thead>
                <tbody>
                  {bt.by_flag.map((f) => {
                    const informative = f.flagged_missed_pct !== null && f.unflagged_missed_pct !== null && f.flagged_missed_pct > f.unflagged_missed_pct;
                    return (
                      <tr key={f.flag} className="border-t">
                        <td className="px-3 py-2 font-medium">{FLAG_LABEL[f.flag]}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(f.flagged_plans)}</td>
                        <td className={cn('px-3 py-2 text-right font-semibold tabular-nums', informative && 'text-destructive')}>{pct(f.flagged_missed_pct)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(f.unflagged_plans)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{pct(f.unflagged_missed_pct)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Callout tone={bt.enough_data ? 'info' : 'warning'} title={bt.enough_data ? 'How to read this' : 'Not enough history yet'}>
              A sign is useful only when plans that had it missed more often than plans that did not (shown in red). Most Rent Plans miss in any given week, so the
              useful question is how much a sign adds. This is one week of history; it will be more reliable as weeks accumulate.
            </Callout>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Rent Plans to follow up"
        description="Highest warning score first. Call the tenant or their agent from here."
        badge={<ObservedBadge />}
        actions={(
          <div className="flex gap-1.5" role="group" aria-label="Minimum warning signs">
            {MIN_OPTIONS.map((o) => (
              <Button key={o.v} type="button" size="sm" variant={minScore === o.v ? 'default' : 'outline'} aria-pressed={minScore === o.v} className="h-9 text-xs" onClick={() => { setMinScore(o.v); setPage(0); }}>
                {o.label}
              </Button>
            ))}
          </div>
        )}
      >
        {isLoading ? <ChartSkeleton h={200} /> : isError ? (
          <WorkspaceEmptyState icon={AlertTriangle} tone="destructive" title="Could not load the early-warning list" hint="Check your connection and try again." />
        ) : (data?.rows.length ?? 0) === 0 ? (
          <WorkspaceEmptyState icon={ShieldAlert} title="No Rent Plans match" hint="No live Rent Plan has that many warning signs in this selection." />
        ) : (
          <div className={cn('space-y-2', isFetching && 'opacity-70')}>
            {data!.rows.map((r) => <WatchRow key={r.rent_request_id} r={r} />)}
            <div className="flex items-center justify-between gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" className="h-8 gap-1 text-xs" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}><ChevronLeft className="h-3.5 w-3.5" /> Previous</Button>
              <span className="text-center text-[11px] text-muted-foreground">Page {page + 1} of {pageCount} · {num(data?.total)} Rent Plans</span>
              <Button type="button" variant="outline" size="sm" className="h-8 gap-1 text-xs" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
