import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, ArrowUp, Building2, FileBarChart, Minus, Plus, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import {
  centresClosing,
  computeConversionRate,
  computeGrowthRate,
  computeGrowthVariancePp,
  type AgentOpsGranularity,
  type AgentOpsReportWindowData,
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

function ZoneB({ data, granularity }: { data: AgentOpsReportWindowData; granularity: AgentOpsGranularity }) {
  const queryClient = useQueryClient();
  const { report, snapshot, priorSnapshot, pipelineNote, pipelineActions } = data;
  const [noteDraft, setNoteDraft] = useState(pipelineNote?.reason_note ?? '');
  const [actionText, setActionText] = useState('');
  const [actionOwner, setActionOwner] = useState('');
  const [actionDue, setActionDue] = useState('');
  const readOnly = report.status.toLowerCase() === 'submitted';

  useEffect(() => {
    setNoteDraft(pipelineNote?.reason_note ?? '');
  }, [pipelineNote?.id, pipelineNote?.reason_note, report.id]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['agent-ops-report-window', granularity] });

  const saveNote = useMutation({
    mutationFn: async (value: string) => {
      const { error } = await supabase
        .from('agent_ops_report_notes')
        .upsert({ report_id: report.id, zone: 'pipeline', reason_note: value.trim() }, { onConflict: 'report_id,zone' });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Pipeline reason note saved.');
      invalidate();
    },
    onError: (mutationError: Error) => toast.error(mutationError.message),
  });

  const addAction = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('agent_ops_report_actions').insert({
        report_id: report.id,
        zone: 'pipeline',
        item_text: actionText.trim(),
        owner_label: actionOwner.trim(),
        due_date: actionDue || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setActionText('');
      setActionOwner('');
      setActionDue('');
      toast.success('Pipeline action added.');
      invalidate();
    },
    onError: (mutationError: Error) => toast.error(mutationError.message),
  });

  const conversionRate = computeConversionRate(snapshot);
  const closing = centresClosing(snapshot);
  const centresNet = snapshot.centres_opened - snapshot.centres_closed;
  const centresDirection = direction(centresNet);
  const CentresIcon = centresDirection.Icon;
  const inPipeline = snapshot.stage_onboarded + snapshot.stage_training + snapshot.stage_qualified;

  const stageNet = (current: number, prior: number | undefined) =>
    prior === undefined ? null : current - prior;

  const stages = [
    {
      key: 'onboarded',
      label: 'Onboarded',
      count: snapshot.stage_onboarded,
      net: stageNet(snapshot.stage_onboarded, priorSnapshot?.stage_onboarded),
      caption: null as string | null,
    },
    {
      key: 'training',
      label: 'Under training',
      count: snapshot.stage_training,
      net: stageNet(snapshot.stage_training, priorSnapshot?.stage_training),
      caption: null as string | null,
    },
    {
      key: 'qualified',
      label: 'Qualified, awaiting first request',
      count: snapshot.stage_qualified,
      net: stageNet(snapshot.stage_qualified, priorSnapshot?.stage_qualified),
      caption: 'Only this stage feeds new_agents.',
    },
  ];

  const noteValid = noteDraft.trim().length >= 80;

  return (
    <section aria-labelledby="agent-ops-zone-b" className="space-y-3">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">Zone B</p>
        <h2 id="agent-ops-zone-b" className="text-lg font-semibold">Onboarding pipeline and service centres</h2>
      </div>

      <Card aria-label="B1 onboarding pipeline">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base">{inPipeline} IN TRAIN</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 p-4 pt-0">
          {/* B1 responsive stacking: single row from 768px up, stacked column below it, never horizontally scrollable */}
          <div className="flex flex-col gap-3 md:flex-row md:items-stretch md:gap-2">
            {stages.map((stage, index) => (
              <div key={stage.key} className="flex flex-1 flex-col gap-3 md:flex-row md:items-center">
                <div className="min-w-0 flex-1 rounded-xl border border-border bg-muted/40 p-3">
                  <p className="text-xs font-medium text-muted-foreground">{stage.label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{stage.count}</p>
                  {stage.caption && <p className="mt-1 text-[11px] text-muted-foreground">{stage.caption}</p>}
                </div>
                <ArrowRight className="hidden h-4 w-4 shrink-0 text-muted-foreground md:block" aria-hidden="true" />
                <ArrowDown className="h-4 w-4 shrink-0 self-center text-muted-foreground md:hidden" aria-hidden="true" />
                {index === -1 && null}
              </div>
            ))}
            <div className="min-w-0 flex-1 rounded-xl border border-primary/30 bg-primary/5 p-3">
              <p className="text-xs font-medium text-muted-foreground">Converted this period</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{snapshot.converted_in_period}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                conversion {conversionRate === null ? '—' : `${conversionRate.toFixed(1)}%`}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {snapshot.converted_in_period} converted ÷ {snapshot.qualified_at_open} qualified at open ={' '}
                {conversionRate === null ? '—' : `${conversionRate.toFixed(1)}%`}
              </p>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Stage</th>
                  <th className="px-3 py-2 text-right font-medium">Count</th>
                  <th className="px-3 py-2 text-right font-medium">Net movement</th>
                </tr>
              </thead>
              <tbody>
                {stages.map((stage) => (
                  <tr key={stage.key} className="border-t border-border">
                    <td className="px-3 py-2">{stage.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{stage.count}</td>
                    <td className={cn('px-3 py-2 text-right tabular-nums', direction(stage.net).className)}>
                      {stage.net === null ? '—' : signedNumber(stage.net)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-border bg-muted/40 font-semibold">
                  <td className="px-3 py-2">In pipeline</td>
                  <td className="px-3 py-2 text-right tabular-nums">{inPipeline}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {stages.some((stage) => stage.net === null)
                      ? '—'
                      : signedNumber(stages.reduce((total, stage) => total + (stage.net ?? 0), 0))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card aria-label="B2 service centres">
        <CardContent className="space-y-3 p-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Building2 className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
            Secondary metric · no target
          </p>
          <p className="flex items-baseline gap-2 text-base font-semibold text-foreground">
            <span className="tabular-nums">Service centres {closing}</span>
            <span className={cn('inline-flex items-center text-sm', centresDirection.className)} aria-label={`${centresDirection.label} this period`}>
              <CentresIcon className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="tabular-nums">{signedNumber(centresNet)}</span>
            </span>
            <span className="text-xs font-normal text-muted-foreground">this period</span>
          </p>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-xs">
              <tbody>
                <tr className="border-b border-border">
                  <td className="px-3 py-1.5 text-muted-foreground">Opening</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{snapshot.centres_opening}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="px-3 py-1.5 text-muted-foreground">Opened this period</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{snapshot.centres_opened}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="px-3 py-1.5 text-muted-foreground">Closed this period</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{snapshot.centres_closed}</td>
                </tr>
                <tr>
                  <td className="px-3 py-1.5 text-muted-foreground">Closing</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{closing}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card aria-label="Zone B narrative">
        <CardContent className="space-y-4 p-4">
          <div className="space-y-2">
            <Label htmlFor="zone-b-reason-note">
              Pipeline reason note <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="zone-b-reason-note"
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              rows={4}
              disabled={readOnly}
              placeholder="Explain what moved the onboarding pipeline this period (minimum 80 characters)."
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {noteDraft.trim().length}/80 characters · separate from Zone A's growth note
              </p>
              <Button
                size="sm"
                disabled={readOnly || !noteValid || saveNote.isPending}
                onClick={() => saveNote.mutate(noteDraft)}
              >
                Save note
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>
              Pipeline action plan <span className="text-destructive">*</span>
            </Label>
            {pipelineActions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No pipeline actions recorded yet — at least one is required.</p>
            ) : (
              <ul className="space-y-1.5">
                {pipelineActions.map((action) => (
                  <li key={action.id} className="rounded-lg border border-border p-2 text-sm">
                    <p className="text-foreground">{action.item_text}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {action.owner_label ?? 'Unassigned'}
                      {action.due_date ? ` · due ${action.due_date}` : ''}
                      {action.outcome ? ` · ${action.outcome.replace('_', ' ')}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && (
              <div className="grid gap-2 md:grid-cols-[2fr_1fr_auto_auto]">
                <Input
                  value={actionText}
                  onChange={(event) => setActionText(event.target.value)}
                  placeholder="Action (min 10 characters)"
                />
                <Input value={actionOwner} onChange={(event) => setActionOwner(event.target.value)} placeholder="Owner" />
                <Input type="date" value={actionDue} onChange={(event) => setActionDue(event.target.value)} />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionText.trim().length < 10 || actionOwner.trim().length === 0 || addAction.isPending}
                  onClick={() => addAction.mutate()}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
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
                  priorSnapshot ? <DirectionValue value={growthVariancePp} kind="points" /> : <p className="text-xl font-medium text-muted-foreground">no prior period</p>
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
                    : 'No comparison available'
                  : <>net change {signedNumber(netChange)} · {priorSnapshot ? <DirectionValue value={growthVariancePp} kind="points" /> : 'no prior period'}</>}
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
