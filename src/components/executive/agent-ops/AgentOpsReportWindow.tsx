import { useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, FileBarChart, Minus, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  computeGrowthRate,
  computeGrowthVariancePp,
  type AgentOpsGranularity,
  useAgentOpsReportWindow,
} from '@/hooks/useAgentOpsReportWindow';
import { cn } from '@/lib/utils';

const PERIODS: { value: AgentOpsGranularity; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

function signedNumber(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return String(value);
  return '0';
}

function signedRate(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function signedPoints(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)} pp`;
}

function rateText(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}%`;
}

function oneDecimalPercent(numerator: number, denominator: number): string {
  return denominator === 0 ? '—' : `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function direction(value: number | null) {
  if (value === null || value === 0) {
    return { Icon: Minus, className: 'text-muted-foreground', label: 'Unchanged' };
  }
  return value > 0
    ? { Icon: ArrowUp, className: 'text-success', label: 'Increase' }
    : { Icon: ArrowDown, className: 'text-destructive', label: 'Decrease' };
}

function DirectionValue({ value, kind }: { value: number | null; kind: 'agents' | 'points' }) {
  const state = direction(value);
  const Icon = state.Icon;
  const formatted = kind === 'agents' ? signedNumber(value ?? 0) : signedPoints(value);
  return (
    <span
      className={cn('inline-flex items-center gap-1.5', state.className)}
      title={`${state.label}: ${formatted}`}
      aria-label={`${state.label}: ${formatted}`}
    >
      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span className="tabular-nums">{formatted}</span>
      <span className="text-sm font-medium">{state.label}</span>
    </span>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <Skeleton className="h-5 w-72" />
        <Skeleton className="mt-4 h-10 w-full max-w-md" />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        {[1, 2, 3].map((item) => (
          <Card key={item}>
            <CardContent className="space-y-3 p-4">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-10 w-28" />
              <Skeleton className="h-4 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function AgentOpsReportWindow() {
  const [granularity, setGranularity] = useState<AgentOpsGranularity>('daily');
  const [dirtyDraft] = useState(false);
  const { data, isLoading, isFetching, isError, error, refetch } = useAgentOpsReportWindow(granularity);

  const handlePeriodChange = (next: AgentOpsGranularity) => {
    if (next === granularity) return;
    if (dirtyDraft && !window.confirm('You have unsaved changes. Switch reporting periods and discard them?')) return;
    setGranularity(next);
  };

  if (isLoading) return <LoadingState />;

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="space-y-3 p-8 text-center">
          <p className="text-sm text-destructive">Could not load the Agent Operations report.</p>
          <p className="text-xs text-muted-foreground">{(error as Error)?.message ?? 'Unknown error'}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { report, snapshot, priorSnapshot, periodLabel } = data;
  const currentGrowthRate = computeGrowthRate(snapshot);
  const growthVariancePp = computeGrowthVariancePp(snapshot, priorSnapshot);
  const netChange = snapshot.new_agents - snapshot.removed_agents;
  const currentDirection = direction(netChange);
  const varianceDirection = direction(growthVariancePp);
  const isDaily = granularity === 'daily';
  const targetLabel = report.target_net_agents === null ? 'No target set' : `Target ${signedNumber(report.target_net_agents)}`;
  const statusLabel = report.status.toLowerCase() === 'submitted' ? 'Submitted' : 'Draft';
  const priorPeriodLabel = priorSnapshot
    ? `${priorSnapshot.period_start} to ${priorSnapshot.period_end}`
    : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="p-4 pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-base">
                <FileBarChart className="h-4 w-4" />
                Agent Operations Report
              </CardTitle>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs uppercase tracking-wide text-muted-foreground">
                <span>Agent Operations Report</span>
                <span aria-hidden="true">·</span>
                <span>{periodLabel}</span>
                <span aria-hidden="true">·</span>
                <Badge variant={report.target_net_agents === null ? 'secondary' : 'outline'}>{targetLabel}</Badge>
                <span aria-hidden="true">·</span>
                <Badge variant={statusLabel === 'Submitted' ? 'default' : 'secondary'}>{statusLabel}</Badge>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', isFetching && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <div role="radiogroup" aria-label="Agent Operations reporting period" className="flex w-full max-w-md items-stretch rounded-xl border border-border bg-muted/70 p-1 shadow-sm">
            {PERIODS.map((period) => {
              const selected = period.value === granularity;
              return (
                <Button
                  key={period.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  variant={selected ? 'default' : 'ghost'}
                  onClick={() => handlePeriodChange(period.value)}
                  className="min-h-[42px] flex-1 rounded-md px-2 text-sm sm:px-4"
                >
                  {period.label}
                </Button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <section aria-labelledby="agent-ops-zone-a" className="space-y-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">Zone A</p>
          <h2 id="agent-ops-zone-a" className="text-lg font-semibold">Agent network movement</h2>
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <Card aria-label="A1 agents on the network">
            <CardContent className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">A1 · Agents on the network</p>
              <p className="mt-3 text-3xl font-semibold tabular-nums text-foreground">{snapshot.closing_agents}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Active share {oneDecimalPercent(snapshot.active_agents_30d, snapshot.closing_agents)}
                <span className="mx-1.5" aria-hidden="true">|</span>
                {targetLabel.toLowerCase()}
              </p>
            </CardContent>
          </Card>

          <Card aria-label="A2 movement this period">
            <CardContent className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">A2 · Movement this period</p>
              <div className="mt-3">
                <p className={cn(isDaily ? 'text-3xl' : 'text-xl', 'font-semibold tabular-nums', currentDirection.className)}>
                  <span title={`${currentDirection.label}: ${signedNumber(netChange)}`} aria-label={`${currentDirection.label}: ${signedNumber(netChange)}`}>
                    {netChange > 0 ? '▲' : netChange < 0 ? '▼' : '–'} {signedNumber(netChange)}
                  </span>
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {snapshot.new_agents} new − {snapshot.removed_agents} removed · growth {signedRate(currentGrowthRate)}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card aria-label="A3 growth rate versus prior">
            <CardContent className="p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">A3 · Growth rate vs prior</p>
              <div className="mt-3">
                {isDaily ? (
                  <DirectionValue value={growthVariancePp} kind="points" />
                ) : (
                  <p className={cn('text-3xl font-semibold tabular-nums', varianceDirection.className)}>
                    {rateText(currentGrowthRate)}
                  </p>
                )}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {isDaily
                  ? priorSnapshot
                    ? `${priorPeriodLabel} ${rateText(computeGrowthRate(priorSnapshot))} → ${periodLabel} ${rateText(currentGrowthRate)}`
                    : 'no prior period'
                  : `net change ${signedNumber(netChange)} · variance ${signedPoints(growthVariancePp)}`}
              </p>
              {priorSnapshot && (
                <p className="mt-3 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <span>{priorPeriodLabel} {rateText(computeGrowthRate(priorSnapshot))}</span>
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{periodLabel} {rateText(currentGrowthRate)}</span>
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">each on its own opening base</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Conversion rate {oneDecimalPercent(snapshot.converted_in_period, snapshot.qualified_at_open)}
              </p>
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}

export default AgentOpsReportWindow;
