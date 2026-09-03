import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, Building2, ChevronDown, ChevronRight, FileBarChart, MapPin, Minus, Plus, RefreshCw, Search } from 'lucide-react';
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
  isIdenticalToPriorNote,
  type AgentOpsGranularity,
  type AgentOpsReportAction,
  type AgentOpsReportWindowData,
  type AgentOpsZone,
  useAgentOpsReportWindow,
} from '@/hooks/useAgentOpsReportWindow';
import { useAgentOpsReportPermissions } from '@/components/executive/agent-ops/agentOpsReportPermissions';
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

function ZoneB({ data }: { data: AgentOpsReportWindowData; granularity: AgentOpsGranularity }) {
  const { snapshot, priorSnapshot } = data;
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
            {stages.map((stage) => (
              <div key={stage.key} className="flex flex-1 flex-col gap-3 md:flex-row md:items-center">
                <div className="min-w-0 flex-1 rounded-xl border border-border bg-muted/40 p-3">
                  <p className="text-xs font-medium text-muted-foreground">{stage.label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{stage.count}</p>
                  {stage.caption && <p className="mt-1 text-[11px] text-muted-foreground">{stage.caption}</p>}
                </div>
                <ArrowRight className="hidden h-4 w-4 shrink-0 text-muted-foreground md:block" aria-hidden="true" />
                <ArrowDown className="h-4 w-4 shrink-0 self-center text-muted-foreground md:hidden" aria-hidden="true" />
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

      </section>
  );
}

function readableError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Something went wrong. Please try again.';
}

function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function nextPeriodDueDate(granularity: AgentOpsGranularity, periodEnd: string): string {
  const [year, month, day] = periodEnd.split('-').map(Number);
  const end = new Date(Date.UTC(year, month - 1, day));
  if (granularity === 'daily') end.setUTCDate(end.getUTCDate() + 1);
  if (granularity === 'weekly') end.setUTCDate(end.getUTCDate() + 7);
  if (granularity === 'monthly') end.setUTCMonth(end.getUTCMonth() + 1);
  return end.toISOString().slice(0, 10);
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Kampala',
  }).format(new Date(value));
}

function actionLabel(granularity: AgentOpsGranularity): string {
  if (granularity === 'daily') return 'Actions for tomorrow';
  if (granularity === 'weekly') return 'Actions for next week';
  return 'Actions for next month';
}

function hasActionPlan(actions: AgentOpsReportAction[]): boolean {
  return actions.some((action) =>
    action.item_text.trim().length >= 10 &&
    Boolean(action.due_date) &&
    Boolean(action.owner_staff_id || action.owner_label?.trim()),
  );
}

function NarrativeSection({
  data,
  zone,
  title,
  actionTitle,
  granularity,
  canEdit,
}: {
  data: AgentOpsReportWindowData;
  zone: AgentOpsZone;
  title: string;
  actionTitle: string;
  granularity: AgentOpsGranularity;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const note = data.notes[zone];
  const actions = data.actions[zone];
  const submitted = data.report.status.toLowerCase() === 'submitted';
  // Read-only covers both a submitted report and a viewer without edit rights.
  const readOnly = submitted || !canEdit;

  const [noteDraft, setNoteDraft] = useState(note?.reason_note ?? '');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [addendumDraft, setAddendumDraft] = useState('');
  const [showAddendum, setShowAddendum] = useState(false);
  const [actionText, setActionText] = useState('');
  const [ownerStaffId, setOwnerStaffId] = useState('');
  const [ownerLabel, setOwnerLabel] = useState('');
  const [dueDate, setDueDate] = useState(() => nextPeriodDueDate(granularity, data.report.period_end));
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['agent-ops-report-window', granularity] });

  useEffect(() => {
    setNoteDraft(note?.reason_note ?? '');
  }, [note?.id, note?.reason_note, data.report.id]);

  const saveNote = useMutation({
    mutationFn: async () => {
      const value = noteDraft.trim();
      if (value.length < 80) throw new Error('Write at least 80 characters explaining what happened and why.');
      if (isIdenticalToPriorNote(value, data.priorNotes[zone])) {
        throw new Error(`this is the same text as ${data.priorPeriodLabel ?? 'the prior period'}; write what actually happened this period`);
      }
      const { error } = await supabase
        .from('agent_ops_report_notes')
        .upsert({ report_id: data.report.id, zone, reason_note: value }, { onConflict: 'report_id,zone' });
      if (error) throw error;
    },
    onSuccess: () => {
      setNoteError(null);
      toast.success(`${title} saved.`);
      invalidate();
    },
    onError: (error) => {
      const message = readableError(error);
      setNoteError(message);
      toast.error(message);
    },
  });

  const addendumMutation = useMutation({
    mutationFn: async () => {
      const value = addendumDraft.trim();
      if (value.length < 1) throw new Error('Write an addendum before saving it.');
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      if (!userData.user) throw new Error('Your session has expired. Sign in again to add a dated addendum.');
      const { error } = await supabase.from('agent_ops_report_addenda').insert({
        report_id: data.report.id,
        zone,
        addendum_text: value,
        created_by: userData.user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setAddendumDraft('');
      setShowAddendum(false);
      toast.success('Dated addendum added.');
      invalidate();
    },
    onError: (error) => toast.error(readableError(error)),
  });

  const addAction = useMutation({
    mutationFn: async () => {
      const item = actionText.trim();
      const selectedOwner = data.staffOptions.find((option) => option.staffId === ownerStaffId);
      if (item.length < 10) throw new Error('Action text must be at least 10 characters.');
      if (!ownerStaffId && ownerLabel.trim().length === 0) throw new Error('Choose a staff owner or enter a non-staff owner.');
      if (!dueDate || dueDate < todayIso()) throw new Error('Due date cannot be in the past.');
      const { error } = await supabase.from('agent_ops_report_actions').insert({
        report_id: data.report.id,
        zone,
        item_text: item,
        owner_staff_id: ownerStaffId || null,
        owner_label: ownerStaffId ? selectedOwner?.label ?? null : ownerLabel.trim(),
        due_date: dueDate,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setActionText('');
      setOwnerStaffId('');
      setOwnerLabel('');
      setDueDate(nextPeriodDueDate(granularity, data.report.period_end));
      toast.success('Action added.');
      invalidate();
    },
    onError: (error) => toast.error(readableError(error)),
  });

  const noteIsValid = noteDraft.trim().length >= 80 && !isIdenticalToPriorNote(noteDraft, data.priorNotes[zone]);
  return (
    <Card aria-label={`${title} narrative`}>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 p-4 pt-0">
        <div className="space-y-2">
          <Label htmlFor={readOnly ? undefined : `${zone}-reason-note`}>
            WHY THESE NUMBERS {!readOnly && <span className="text-destructive">*</span>}
          </Label>
          {readOnly ? (
            /* READ-ONLY RENDER BRANCH — rendered text, never a disabled input. */
            <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
              {note ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    {submitted ? 'Original note · never edited after submission' : 'Recorded explanation'}
                  </p>
                  <p className="whitespace-pre-wrap text-sm">{note.reason_note}</p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No explanation recorded for this period yet.</p>
              )}
              {data.addenda[zone].map((addendum) => (
                <div key={addendum.id} className="border-t border-border pt-2 text-sm">
                  <p className="text-xs text-muted-foreground">
                    Addendum · {formatTimestamp(addendum.created_at)} · {addendum.author_name ?? 'Officer'}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{addendum.addendum_text}</p>
                </div>
              ))}
              {submitted && canEdit && (
                !showAddendum ? (
                  <Button variant="outline" size="sm" onClick={() => setShowAddendum(true)}>Add dated addendum</Button>
                ) : (
                  <div className="space-y-2">
                    <Textarea value={addendumDraft} onChange={(event) => setAddendumDraft(event.target.value)} rows={3} placeholder="Record the correction or follow-up." />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => addendumMutation.mutate()} disabled={!addendumDraft.trim() || addendumMutation.isPending}>Save addendum</Button>
                      <Button variant="ghost" size="sm" onClick={() => setShowAddendum(false)}>Cancel</Button>
                    </div>
                  </div>
                )
              )}
            </div>
          ) : (
            <>
              <Textarea
                id={`${zone}-reason-note`}
                value={noteDraft}
                onChange={(event) => { setNoteDraft(event.target.value); setNoteError(null); }}
                rows={4}
                placeholder="Explain what happened this period and why."
              />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{noteDraft.trim().length}/80 characters</span>
                <Button size="sm" onClick={() => saveNote.mutate()} disabled={!noteIsValid || saveNote.isPending}>Save explanation</Button>
              </div>
              {noteError && <p className="text-sm text-destructive">{noteError}</p>}
              {data.priorNotes[zone] && isIdenticalToPriorNote(noteDraft, data.priorNotes[zone]) && (
                <p className="text-sm text-destructive">this is the same text as {data.priorPeriodLabel ?? 'the prior period'}; write what actually happened this period</p>
              )}
            </>
          )}
        </div>

        <div className="space-y-2">
          <Label>{actionTitle} {!readOnly && <span className="text-destructive">*</span>}</Label>
          {actions.map((action) => (
            <div key={action.id} className="rounded-lg border border-border p-3 text-sm">
              <p>{action.item_text}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {action.owner_label ?? data.staffOptions.find((option) => option.staffId === action.owner_staff_id)?.label ?? 'Staff owner'} · due {action.due_date}
              </p>
            </div>
          ))}
          {actions.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {readOnly ? 'No actions were recorded for this period.' : 'No actions added yet. At least one action is required.'}
            </p>
          )}
          {!readOnly && (
            <div className="grid gap-2 md:grid-cols-2">
              <Input value={actionText} onChange={(event) => setActionText(event.target.value)} placeholder="Action item (minimum 10 characters)" />
              <select
                aria-label={`${title} action staff owner`}
                value={ownerStaffId}
                onChange={(event) => { setOwnerStaffId(event.target.value); if (event.target.value) setOwnerLabel(''); }}
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Non-staff owner / choose below</option>
                {data.staffOptions.map((option) => <option key={option.staffId} value={option.staffId}>{option.label}</option>)}
              </select>
              {!ownerStaffId && <Input value={ownerLabel} onChange={(event) => setOwnerLabel(event.target.value)} placeholder="Non-staff owner label" />}
              <Input type="date" min={todayIso()} value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
              <Button variant="outline" onClick={() => addAction.mutate()} disabled={addAction.isPending || actionText.trim().length < 10 || (!ownerStaffId && !ownerLabel.trim()) || !dueDate || dueDate < todayIso()}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add action
              </Button>
            </div>
          )}
          {!readOnly && <p className="text-xs text-muted-foreground">{actionTitle} · due dates must be today or later.</p>}
        </div>
      </CardContent>
    </Card>
  );
}


function PriorPeriodCloseout({ data, granularity, canEdit }: { data: AgentOpsReportWindowData; granularity: AgentOpsGranularity; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isCarrying, setIsCarrying] = useState(false);
  const readOnly = data.report.status.toLowerCase() === 'submitted' || !canEdit;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['agent-ops-report-window', granularity] });

  const updateOutcome = async (action: AgentOpsReportAction) => {
    const outcome = outcomes[action.id] ?? action.outcome ?? '';
    const outcomeNote = (notes[action.id] ?? action.outcome_note ?? '').trim();
    if (!outcome || !outcomeNote) {
      setError('Each prior-period action needs an outcome and a one-line result before submission.');
      return;
    }
    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      if (!userData.user) throw new Error('Your session has expired. Sign in again to close out actions.');
      const { error: updateError } = await supabase
        .from('agent_ops_report_actions')
        .update({ outcome, outcome_note: outcomeNote, closed_at: new Date().toISOString(), closed_by: userData.user.id })
        .eq('id', action.id);
      if (updateError) throw updateError;
      toast.success('Prior-period action closed out.');
      setError(null);
      invalidate();
    } catch (updateError) {
      const message = readableError(updateError);
      setError(message);
      toast.error(message);
    }
  };

  const carryActions = async () => {
    setIsCarrying(true);
    try {
      const { error: carryError } = await supabase.rpc('agent_ops_carry_actions', { p_report_id: data.report.id });
      if (carryError) throw carryError;
      toast.success('Open prior-period actions carried into this report.');
      invalidate();
    } catch (carryError) {
      const message = readableError(carryError);
      setError(message);
      toast.error(message);
    } finally {
      setIsCarrying(false);
    }
  };

  if (!data.priorPeriodLabel) {
    return <Card><CardContent className="p-4 text-sm text-muted-foreground">No prior period actions to close out.</CardContent></Card>;
  }

  return (
    <Card aria-label="Prior period close-out">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">Prior period close-out · {data.priorPeriodLabel}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {data.priorActions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No actions were recorded in the prior period.</p>
        ) : data.priorActions.map((action) => {
          const outcome = outcomes[action.id] ?? action.outcome ?? '';
          const outcomeNote = notes[action.id] ?? action.outcome_note ?? '';
          const closed = Boolean(action.outcome && action.outcome_note?.trim());
          return (
            <div key={action.id} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{action.item_text}</p>
                  <p className="text-xs text-muted-foreground">From {action.priorPeriodLabel}</p>
                </div>
                {action.flaggedToReviewer && <Badge variant="destructive">flagged to reviewer</Badge>}
              </div>
              {readOnly ? (
                <div className="text-sm">
                  <p>
                    Outcome:{' '}
                    <span className="font-medium">
                      {outcome === 'done' ? 'Done' : outcome === 'partly_done' ? 'Partly done' : outcome === 'not_done' ? 'Not done' : 'Not closed out'}
                    </span>
                  </p>
                  <p className="text-muted-foreground">{outcomeNote.trim() || 'No result recorded.'}</p>
                </div>
              ) : (
                <div className="grid gap-2 md:grid-cols-[180px_1fr_auto]">
                  <select
                    aria-label={`Outcome for ${action.item_text}`}
                    value={outcome}
                    disabled={closed}
                    onChange={(event) => setOutcomes((current) => ({ ...current, [action.id]: event.target.value }))}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">Choose outcome</option>
                    <option value="done">Done</option>
                    <option value="partly_done">Partly done</option>
                    <option value="not_done">Not done</option>
                  </select>
                  <Input value={outcomeNote} disabled={closed} onChange={(event) => setNotes((current) => ({ ...current, [action.id]: event.target.value }))} placeholder="One-line result" />
                  <Button size="sm" variant="outline" disabled={closed || !outcome || !outcomeNote.trim()} onClick={() => updateOutcome(action)}>Save outcome</Button>
                </div>
              )}

              {closed && <p className="text-xs text-muted-foreground">Close-out recorded.</p>}
            </div>
          );
        })}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!readOnly && data.priorActions.some((action) => !action.outcome) && (
          <Button variant="outline" size="sm" onClick={carryActions} disabled={isCarrying}>
            {isCarrying ? 'Carrying actions…' : 'Carry open actions into this report'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function buildSubmitGateChecklist(data: AgentOpsReportWindowData): { label: string; complete: boolean }[] {
  const noteCheck = (zone: AgentOpsZone) => data.notes[zone]?.reason_note?.trim().length >= 80;
  const freshCheck = (zone: AgentOpsZone) => !isIdenticalToPriorNote(data.notes[zone]?.reason_note ?? '', data.priorNotes[zone]);
  const priorCloseout = data.priorActions.every((action) => Boolean(action.outcome && action.outcome_note?.trim()));
  return [
    { label: 'Zone A explanation is at least 80 characters', complete: noteCheck('growth') },
    { label: 'Zone A explanation is different from the prior period', complete: noteCheck('growth') && freshCheck('growth') },
    { label: 'Zone A has at least one action with an owner and due date', complete: hasActionPlan(data.actions.growth) },
    { label: 'Zone B explanation is at least 80 characters', complete: noteCheck('pipeline') },
    { label: 'Zone B explanation is different from the prior period', complete: noteCheck('pipeline') && freshCheck('pipeline') },
    { label: 'Zone B has at least one action with an owner and due date', complete: hasActionPlan(data.actions.pipeline) },
    { label: 'Every prior-period action has an outcome and result note', complete: priorCloseout },
  ];
}

function ReportNarratives({ data, granularity, canEdit }: { data: AgentOpsReportWindowData; granularity: AgentOpsGranularity; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const checklist = buildSubmitGateChecklist(data);
  const submitted = data.report.status.toLowerCase() === 'submitted';
  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('agent_ops_submit_report', { p_report_id: data.report.id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Agent Operations report submitted.');
      queryClient.invalidateQueries({ queryKey: ['agent-ops-report-window', granularity] });
    },
    onError: (error) => toast.error(readableError(error)),
  });

  return (
    <section aria-labelledby="agent-ops-narratives" className="space-y-3">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">Report narrative</p>
        <h2 id="agent-ops-narratives" className="text-lg font-semibold">
          {canEdit ? 'Explain the movement and commit the next actions' : 'Officer narrative and committed actions'}
        </h2>
      </div>
      <NarrativeSection data={data} zone="growth" title="Zone A — WHY THESE NUMBERS" actionTitle={actionLabel(granularity)} granularity={granularity} canEdit={canEdit} />
      <NarrativeSection data={data} zone="pipeline" title="Zone B — WHY THESE NUMBERS" actionTitle={actionLabel(granularity)} granularity={granularity} canEdit={canEdit} />
      <PriorPeriodCloseout data={data} granularity={granularity} canEdit={canEdit} />
      {(submitted || canEdit) && (
        <Card aria-label="Submit Agent Operations report">
          <CardContent className="space-y-3 p-4">
            {submitted ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <Badge>Submitted</Badge>
                <span>by {data.submittedByName ?? 'the submitting officer'}</span>
                <span className="text-muted-foreground">{formatTimestamp(data.submittedAt)}</span>
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  {checklist.map((item) => (
                    <p key={item.label} className={cn('text-sm', item.complete ? 'text-success' : 'text-muted-foreground')}>
                      {item.complete ? '✓' : '○'} {item.label}
                    </p>
                  ))}
                </div>
                <Button onClick={() => submit.mutate()} disabled={submit.isPending || !checklist.every((item) => item.complete)}>
                  {submit.isPending ? 'Submitting…' : 'Submit report'}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Zone C — district and area coverage.
// Always reads the CURRENT DAILY snapshot; the Daily/Weekly/Monthly toggle
// does not affect it. District and area names resolve only through the ug_*
// reference tables (never profiles.district or any free-text location field).
// ---------------------------------------------------------------------------

interface ZoneCArea {
  id: string;
  name: string;
  agentCount: number;
  netChange: number;
  activeAgents: number;
}

interface ZoneCDistrict {
  key: string;
  districtId: number | null;
  name: string;
  aliases: string[];
  agentCount: number;
  netChange: number;
  activeAgents: number;
  areas: ZoneCArea[];
}

interface ZoneCData {
  districts: ZoneCDistrict[];
  unassigned: ZoneCDistrict | null;
  snapshotDate: string | null;
  closingAgents: number | null;
}

function activePercent(activeAgents: number, agentCount: number): string {
  if (agentCount <= 0) return '—';
  return `${((activeAgents / agentCount) * 100).toFixed(1)}%`;
}

/** Sorted by net_change descending, then by agent_count descending as tie-break. */
function zoneCSortComparator(a: ZoneCDistrict, b: ZoneCDistrict): number {
  if (b.netChange !== a.netChange) return b.netChange - a.netChange;
  return b.agentCount - a.agentCount;
}

/** Case-insensitive match on district name, its ug_district_aliases, and any subcounty name. */
function zoneCMatchesSearch(district: ZoneCDistrict, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (needle.length === 0) return true;
  if (district.name.toLowerCase().includes(needle)) return true;
  if (district.aliases.some((alias) => alias.toLowerCase().includes(needle))) return true;
  return district.areas.some((area) => area.name.toLowerCase().includes(needle));
}

function useZoneCCoverage() {
  return useQuery({
    queryKey: ['agent-ops-zone-c-coverage'],
    queryFn: async (): Promise<ZoneCData> => {
      const { data: dailyRows, error: dailyError } = await supabase
        .from('agent_ops_period_snapshots')
        .select('id, period_start, closing_agents')
        .eq('granularity', 'daily')
        .order('period_start', { ascending: false })
        .limit(1);
      if (dailyError) throw dailyError;

      const daily = (dailyRows ?? [])[0] as { id: string; period_start: string; closing_agents: number } | undefined;
      if (!daily) return { districts: [], unassigned: null, snapshotDate: null, closingAgents: null };

      const { data: rows, error: rowsError } = await supabase
        .from('agent_ops_district_snapshots')
        .select('id, district_id, subcounty_id, agent_count, net_change, active_agents_30d')
        .eq('snapshot_id', daily.id);
      if (rowsError) throw rowsError;

      const snapshotRows = (rows ?? []) as {
        id: string;
        district_id: number | null;
        subcounty_id: number | null;
        agent_count: number;
        net_change: number;
        active_agents_30d: number;
      }[];

      const districtIds = Array.from(
        new Set(snapshotRows.map((row) => row.district_id).filter((value): value is number => value !== null)),
      );
      const subcountyIds = Array.from(
        new Set(snapshotRows.map((row) => row.subcounty_id).filter((value): value is number => value !== null)),
      );

      const [districtRes, subcountyRes, aliasRes] = await Promise.all([
        districtIds.length
          ? supabase.from('ug_districts').select('id, name').in('id', districtIds)
          : Promise.resolve({ data: [], error: null }),
        subcountyIds.length
          ? supabase.from('ug_subcounties').select('id, name').in('id', subcountyIds)
          : Promise.resolve({ data: [], error: null }),
        districtIds.length
          ? supabase.from('ug_district_aliases').select('district_id, alias').in('district_id', districtIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (districtRes.error) throw districtRes.error;
      if (subcountyRes.error) throw subcountyRes.error;
      if (aliasRes.error) throw aliasRes.error;

      const districtNames = new Map<number, string>(
        ((districtRes.data ?? []) as { id: number; name: string }[]).map((row) => [row.id, row.name]),
      );
      const subcountyNames = new Map<number, string>(
        ((subcountyRes.data ?? []) as { id: number; name: string }[]).map((row) => [row.id, row.name]),
      );
      const aliasMap = new Map<number, string[]>();
      for (const row of (aliasRes.data ?? []) as { district_id: number; alias: string }[]) {
        aliasMap.set(row.district_id, [...(aliasMap.get(row.district_id) ?? []), row.alias]);
      }

      const buckets = new Map<string, ZoneCDistrict>();
      const ensure = (districtId: number | null): ZoneCDistrict => {
        const key = districtId === null ? 'unassigned' : String(districtId);
        const existing = buckets.get(key);
        if (existing) return existing;
        const created: ZoneCDistrict = {
          key,
          districtId,
          name: districtId === null ? 'Unassigned district' : districtNames.get(districtId) ?? `District ${districtId}`,
          aliases: districtId === null ? [] : aliasMap.get(districtId) ?? [],
          agentCount: 0,
          netChange: 0,
          activeAgents: 0,
          areas: [],
        };
        buckets.set(key, created);
        return created;
      };

      for (const row of snapshotRows) {
        const bucket = ensure(row.district_id);
        if (row.subcounty_id === null) {
          bucket.agentCount += row.agent_count;
          bucket.netChange += row.net_change;
          bucket.activeAgents += row.active_agents_30d;
        } else {
          bucket.areas.push({
            id: row.id,
            name: subcountyNames.get(row.subcounty_id) ?? `Area ${row.subcounty_id}`,
            agentCount: row.agent_count,
            netChange: row.net_change,
            activeAgents: row.active_agents_30d,
          });
        }
      }

      for (const bucket of buckets.values()) {
        bucket.areas.sort((a, b) =>
          b.netChange !== a.netChange ? b.netChange - a.netChange : b.agentCount - a.agentCount,
        );
      }

      const unassigned = buckets.get('unassigned') ?? null;
      const districts = Array.from(buckets.values())
        .filter((bucket) => bucket.districtId !== null && bucket.agentCount > 0)
        .sort(zoneCSortComparator);

      return {
        districts,
        unassigned: unassigned && unassigned.agentCount > 0 ? unassigned : null,
        snapshotDate: daily.period_start,
        closingAgents: daily.closing_agents,
      };
    },
  });
}

function ZoneCNet({ value }: { value: number }) {
  const info = direction(value);
  const Icon = info.Icon;
  return (
    <span className={cn('inline-flex items-center gap-0.5 tabular-nums', info.className)}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {signedNumber(value)}
    </span>
  );
}

function ZoneCAreaTable({ areas }: { areas: ZoneCArea[] }) {
  if (areas.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">No area breakdown recorded for this district.</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {areas.map((area) => (
        <li key={area.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1 truncate" title={area.name}>{area.name}</span>
          <span className="w-14 shrink-0 text-right tabular-nums">{area.agentCount}</span>
          <span className="w-16 shrink-0 text-right"><ZoneCNet value={area.netChange} /></span>
          <span className="w-16 shrink-0 text-right tabular-nums">{activePercent(area.activeAgents, area.agentCount)}</span>
        </li>
      ))}
    </ul>
  );
}

function ZoneC() {
  const { data, isLoading, isError, error } = useZoneCCoverage();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const visible = useMemo(
    () => (data?.districts ?? []).filter((district) => zoneCMatchesSearch(district, search)),
    [data?.districts, search],
  );
  const unassigned = data?.unassigned ?? null;
  const unassignedVisible = unassigned && zoneCMatchesSearch(unassigned, search) ? unassigned : null;

  const totals = useMemo(() => {
    const all = [...(data?.districts ?? []), ...(unassigned ? [unassigned] : [])];
    return all.reduce(
      (acc, row) => ({
        agentCount: acc.agentCount + row.agentCount,
        netChange: acc.netChange + row.netChange,
        activeAgents: acc.activeAgents + row.activeAgents,
      }),
      { agentCount: 0, netChange: 0, activeAgents: 0 },
    );
  }, [data?.districts, unassigned]);

  /** The pinned total must equal A1's closing_agents, or we warn instead of showing a wrong total. */
  const reconciles = data?.closingAgents === null || data?.closingAgents === undefined
    ? true
    : totals.agentCount === data.closingAgents;

  return (
    <section aria-labelledby="agent-ops-zone-c" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">Zone C</p>
          <h2 id="agent-ops-zone-c" className="text-lg font-semibold">District and area coverage</h2>
          <p className="text-xs text-muted-foreground">
            Always current daily snapshot{data?.snapshotDate ? ` (${data.snapshotDate})` : ''} — not affected by the
            Daily/Weekly/Monthly toggle.
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search district or area"
            className="pl-8"
            aria-label="Search district or area"
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          ) : isError ? (
            <p className="p-4 text-sm text-destructive">{(error as Error)?.message ?? 'Coverage could not be loaded.'}</p>
          ) : (
            <>
              {/* Desktop: fixed-width columns, truncation with tooltip, no overflow */}
              <div className="hidden md:block">
                <table className="w-full table-fixed text-sm">
                  <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">District / area</th>
                      <th className="w-24 px-3 py-2 text-right font-medium">Agents</th>
                      <th className="w-24 px-3 py-2 text-right font-medium">Net</th>
                      <th className="w-24 px-3 py-2 text-right font-medium">Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.length === 0 && !unassignedVisible && (
                      <tr>
                        <td colSpan={4} className="px-3 py-4 text-center text-sm text-muted-foreground">
                          No districts match this search.
                        </td>
                      </tr>
                    )}
                    {visible.map((district) => (
                      <Fragment key={district.key}>
                        <tr className="border-t border-border">
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => toggle(district.key)}
                              aria-expanded={Boolean(expanded[district.key])}
                              className="flex w-full min-w-0 items-center gap-1.5 text-left"
                            >
                              {expanded[district.key] ? (
                                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                              )}
                              <span className="truncate" title={district.name}>{district.name}</span>
                            </button>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{district.agentCount}</td>
                          <td className="px-3 py-2 text-right"><ZoneCNet value={district.netChange} /></td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {activePercent(district.activeAgents, district.agentCount)}
                          </td>
                        </tr>
                        {expanded[district.key] && (
                          <tr className="border-t border-border bg-muted/30">
                            <td colSpan={4} className="p-0">
                              <ZoneCAreaTable areas={district.areas} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                    {unassignedVisible && (
                      <tr className="border-t border-dashed border-amber-500/50 bg-amber-500/5">
                        <td className="px-3 py-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <MapPin className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
                            <span className="truncate font-medium text-amber-700 dark:text-amber-400" title={unassignedVisible.name}>
                              {unassignedVisible.name}
                            </span>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{unassignedVisible.agentCount}</td>
                        <td className="px-3 py-2 text-right"><ZoneCNet value={unassignedVisible.netChange} /></td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {activePercent(unassignedVisible.activeAgents, unassignedVisible.agentCount)}
                        </td>
                      </tr>
                    )}
                    <tr className="border-t-2 border-border bg-muted/50 font-semibold">
                      <td className="px-3 py-2">
                        All districts
                        {!reconciles && (
                          <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-destructive">
                            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                            Does not reconcile with A1 closing agents ({data?.closingAgents})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{totals.agentCount}</td>
                      <td className="px-3 py-2 text-right"><ZoneCNet value={totals.netChange} /></td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {activePercent(totals.activeAgents, totals.agentCount)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Below 768px: stacked cards, areas in an expander, never a horizontal scroller */}
              <div className="space-y-2 p-3 md:hidden">
                {visible.length === 0 && !unassignedVisible && (
                  <p className="py-2 text-center text-sm text-muted-foreground">No districts match this search.</p>
                )}
                {[...visible, ...(unassignedVisible ? [unassignedVisible] : [])].map((district) => (
                  <div
                    key={district.key}
                    className={cn(
                      'rounded-xl border border-border p-3',
                      district.districtId === null && 'border-dashed border-amber-500/50 bg-amber-500/5',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(district.key)}
                      aria-expanded={Boolean(expanded[district.key])}
                      className="flex w-full items-center justify-between gap-2 text-left"
                    >
                      <span
                        className={cn(
                          'min-w-0 truncate text-sm font-medium',
                          district.districtId === null && 'text-amber-700 dark:text-amber-400',
                        )}
                        title={district.name}
                      >
                        {district.name}
                      </span>
                      {expanded[district.key] ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                    </button>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <p className="text-muted-foreground">Agents</p>
                        <p className="tabular-nums font-semibold">{district.agentCount}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Net</p>
                        <p className="font-semibold"><ZoneCNet value={district.netChange} /></p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Active</p>
                        <p className="tabular-nums font-semibold">{activePercent(district.activeAgents, district.agentCount)}</p>
                      </div>
                    </div>
                    {expanded[district.key] && (
                      <div className="mt-2 rounded-lg border border-border">
                        <ZoneCAreaTable areas={district.areas} />
                      </div>
                    )}
                  </div>
                ))}
                <div className="rounded-xl border-2 border-border bg-muted/50 p-3">
                  <p className="text-sm font-semibold">All districts</p>
                  {!reconciles && (
                    <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-destructive">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                      Does not reconcile with A1 closing agents ({data?.closingAgents})
                    </p>
                  )}
                  <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <p className="text-muted-foreground">Agents</p>
                      <p className="tabular-nums font-semibold">{totals.agentCount}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Net</p>
                      <p className="font-semibold"><ZoneCNet value={totals.netChange} /></p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Active</p>
                      <p className="tabular-nums font-semibold">{activePercent(totals.activeAgents, totals.agentCount)}</p>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

export function AgentOpsReportWindow() {
  const [granularity, setGranularity] = useState<AgentOpsGranularity>('daily');
  const [dirtyDraft] = useState(false);
  const queryClient = useQueryClient();
  // VISIBILITY: read access is NOT gated here — anyone who can reach the Agent
  // Operations dashboard sees this window. Only editing is role-limited.
  const { canEdit, canManageSettings } = useAgentOpsReportPermissions();
  const { data, isLoading, isFetching, isError, error, refetch } = useAgentOpsReportWindow(granularity);

  const computeSnapshot = useMutation({
    mutationFn: async (periodStart: string) => {
      const { error: rpcError } = await supabase.rpc('agent_ops_compute_snapshot', {
        p_granularity: granularity,
        p_period_start: periodStart,
      });
      if (rpcError) throw rpcError;
    },
    onSuccess: () => {
      toast.success('Snapshot computed.');
      queryClient.invalidateQueries({ queryKey: ['agent-ops-report-window', granularity] });
    },
    onError: (err) => toast.error(readableError(err)),
  });

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

  if (!data.ready) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="space-y-3 p-8 text-center">
            <p className="text-sm font-medium">not yet computed</p>
            <p className="text-xs text-muted-foreground">
              No snapshot exists for the selected {granularity} period starting {data.periodStart}.
            </p>
            {canManageSettings && (
              <Button size="sm" onClick={() => computeSnapshot.mutate(data.periodStart)} disabled={computeSnapshot.isPending}>
                {computeSnapshot.isPending ? 'Computing…' : 'Compute now'}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const { report, snapshot, priorSnapshot, periodLabel } = data;
  const currentGrowthRate = computeGrowthRate(snapshot);
  const growthVariancePp = computeGrowthVariancePp(snapshot, priorSnapshot);
  const netChange = snapshot.new_agents - snapshot.removed_agents;
  const currentDirection = direction(netChange);
  const varianceDirection = direction(growthVariancePp);
  const isDaily = granularity === 'daily';
  const hasTarget = report.target_net_agents !== null;
  const targetLabel = hasTarget ? `Target ${signedNumber(report.target_net_agents)}` : 'No target set';
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
                <Badge variant={hasTarget ? 'outline' : 'secondary'}>{targetLabel}</Badge>
                <span aria-hidden="true">·</span>
                <Badge variant={statusLabel === 'Submitted' ? 'default' : 'secondary'}>{statusLabel}</Badge>
                {snapshot.provisional && (
                  <>
                    <span aria-hidden="true">·</span>
                    <Badge variant="secondary">provisional, recomputes at 03:10</Badge>
                  </>
                )}
                {!canEdit && (
                  <>
                    <span aria-hidden="true">·</span>
                    <Badge variant="outline">View only</Badge>
                  </>
                )}
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
                {hasTarget && (
                  <>
                    <span className="mx-1.5" aria-hidden="true">|</span>
                    {targetLabel.toLowerCase()}
                  </>
                )}
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
                {!priorSnapshot ? (
                  <p className="text-xl font-medium text-muted-foreground">no prior period</p>
                ) : isDaily ? (
                  <DirectionValue value={growthVariancePp} kind="points" />
                ) : (
                  (() => {
                    const state = direction(currentGrowthRate);
                    const Icon = state.Icon;
                    return (
                      <span
                        className={cn('inline-flex items-center gap-1.5 text-3xl font-semibold tabular-nums', state.className)}
                        title={`${state.label}: ${signedRate(currentGrowthRate)}`}
                        aria-label={`${state.label}: ${signedRate(currentGrowthRate)}`}
                      >
                        <Icon className="h-6 w-6 shrink-0" aria-hidden="true" />
                        <span>{signedRate(currentGrowthRate)}</span>
                        <span className="text-sm font-medium">{state.label}</span>
                      </span>
                    );
                  })()
                )}
              </div>
              {priorSnapshot && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {isDaily ? (
                    <>{priorPeriodLabel} {rateText(computeGrowthRate(priorSnapshot))} → {periodLabel} {rateText(currentGrowthRate)}</>
                  ) : (
                    <><DirectionValue value={growthVariancePp} kind="points" /> vs {priorPeriodLabel}</>
                  )}
                </p>
              )}
              {priorSnapshot && (
                <p className="mt-3 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <span>{priorPeriodLabel} {rateText(computeGrowthRate(priorSnapshot))}</span>
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{periodLabel} {rateText(currentGrowthRate)}</span>
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">each on its own opening base</p>
            </CardContent>
          </Card>
        </div>
      </section>

      <ZoneB data={data} granularity={granularity} />

      <ZoneC />

      <ReportNarratives data={data} granularity={granularity} canEdit={canEdit} />
    </div>
  );
}


export default AgentOpsReportWindow;
