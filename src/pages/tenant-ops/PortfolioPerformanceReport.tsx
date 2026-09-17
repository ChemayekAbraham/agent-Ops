import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, addMonths, format, parseISO, subDays, subMonths } from 'date-fns';
import { AlertTriangle, BarChart3, CalendarRange, CheckCircle2, ChevronLeft, ChevronRight, FileText, ArrowLeft, X } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { PeriodToggle, type TppoGranularity } from '@/components/tenant-ops/tppo/PeriodToggle';
import { HeadlineA1 } from '@/components/tenant-ops/tppo/HeadlineA1';
import { VarianceA2 } from '@/components/tenant-ops/tppo/VarianceA2';
import { ArrearsMovementA2b } from '@/components/tenant-ops/tppo/ArrearsMovementA2b';
import { WeeklyArrearsSheet } from '@/components/tenant-ops/tppo/WeeklyArrearsSheet';
import { ProjectionA3 } from '@/components/tenant-ops/tppo/ProjectionA3';
import { TppoPlanDetailTable } from '@/components/executive/tppo/TppoPlanDetailTable';
import {
  NarrativeCollections,
  type DraftAction,
} from '@/components/tenant-ops/tppo/NarrativeCollections';
import {
  CarriedActions,
  type CarriedActionRow,
  type CarriedCloseOut,
} from '@/components/tenant-ops/tppo/CarriedActions';
import { SubmitGate } from '@/components/tenant-ops/tppo/SubmitGate';
import { ReportArchiveList } from '@/components/reports/ReportArchiveList';
import type { TppoZoneAReport } from '@/components/tenant-ops/tppo/tppoTypes';



/** Kampala-local anchor date (YYYY-MM-DD) for today. */
function kampalaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** "Monday 01 September 2026" for a plain YYYY-MM-DD string. */
function periodInWords(
  granularity: TppoGranularity,
  periodStart: string | null,
  periodEnd: string | null,
): string {
  if (!periodStart) return '—';
  const longDate = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, d)));
  };
  if (granularity === 'day' || !periodEnd) return longDate(periodStart);
  return `${longDate(periodStart)} to ${longDate(periodEnd)}`;
}

/** The day before a period start, used as the anchor for the prior period. */
function priorAnchor(periodStart: string): string {
  const [y, m, d] = periodStart.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return prev.toISOString().slice(0, 10);
}


export default function PortfolioPerformanceReport({ onBack }: { onBack?: () => void } = {}) {
  const navigate = useNavigate();
  const handleClose = () => {
    if (onBack) {
      onBack();
      return;
    }
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/executive-hub?tab=agent-ops');
    }
  };

  // Each period state holds its own record: the query key is the sole carrier of
  // state, so nothing (figure, text or draft) crosses between Daily/Weekly/Monthly.
  const [granularity, setGranularity] = useState<TppoGranularity>('day');
  const [anchor, setAnchor] = useState<string>(() => kampalaToday());

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tppo-report-zone-a', granularity, anchor],
    queryFn: async (): Promise<TppoZoneAReport> => {
      const { data: rpcData, error: rpcError } = await supabase.rpc('tppo_get_report_zone_a', {
        p_granularity: granularity,
        p_anchor: anchor,
      });
      if (rpcError) throw rpcError;
      return (rpcData ?? {}) as unknown as TppoZoneAReport;
    },
  });

  // One period further back than `data.prior`, so the variance table can show
  // the two closed periods alongside the still-counting current one.
  const earlierAnchor = data?.prior?.period_start ? priorAnchor(data.prior.period_start) : null;
  const { data: earlier } = useQuery({
    queryKey: ['tppo-report-zone-a', granularity, earlierAnchor],
    enabled: Boolean(earlierAnchor),
    queryFn: async (): Promise<TppoZoneAReport> => {
      const { data: rpcData, error: rpcError } = await supabase.rpc('tppo_get_report_zone_a', {
        p_granularity: granularity,
        p_anchor: earlierAnchor as string,
      });
      if (rpcError) throw rpcError;
      return (rpcData ?? {}) as unknown as TppoZoneAReport;
    },
  });

  const periodStart = data?.period_start ?? null;
  const periodEnd = data?.period_end ?? null;
  const submitted = data?.status === 'submitted';
  const reportId = data?.report_id ?? null;

  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [actionDrafts, setActionDrafts] = useState<Record<string, DraftAction[]>>({});
  const [closeOutDrafts, setCloseOutDrafts] = useState<
    Record<string, Record<string, CarriedCloseOut>>
  >({});
  const draftKey = `${granularity}:${periodStart ?? 'none'}`;

  const queryClient = useQueryClient();

  const narrative = useQuery({
    queryKey: ['tppo-narrative-collections', granularity, periodStart, reportId],
    enabled: Boolean(periodStart),
    queryFn: async () => {
      const { data: priorBounds, error: boundsError } = await supabase.rpc(
        'tppo_period_bounds',
        { p_granularity: granularity, p_anchor: priorAnchor(periodStart as string) },
      );
      if (boundsError) throw boundsError;
      const priorStart = priorBounds?.[0]?.period_start ?? null;

      let priorNote: string | null = null;
      let carriedRows: CarriedActionRow[] = [];

      if (priorStart) {
        const { data: priorReport } = await supabase
          .from('tppo_reports')
          .select('id')
          .eq('granularity', granularity)
          .eq('period_start', priorStart)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (priorReport?.id) {
          const { data: priorNoteRow } = await supabase
            .from('tppo_report_notes')
            .select('reason_note')
            .eq('report_id', priorReport.id)
            .eq('zone', 'collections')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          priorNote = priorNoteRow?.reason_note ?? null;

          const { data: priorActions } = await supabase
            .from('tppo_report_actions')
            .select(
              'id, item_text, owner_label, owner_staff_id, due_date, outcome, carried_from_action_id',
            )
            .eq('report_id', priorReport.id)
            .eq('zone', 'collections')
            .order('created_at', { ascending: true });

          carriedRows = (priorActions ?? [])
            .filter((a) => a.carried_from_action_id === null || a.outcome === 'not_done')
            .map((a) => ({
              id: a.id,
              item_text: a.item_text,
              owner: a.owner_label ?? 'Owner on staff',
              due_date: a.due_date,
              repeatNotDone: a.outcome === 'not_done',
            }));
        }
      }

      let submittedNote: string | null = null;
      let submittedActions: Array<{ item_text: string; owner: string; due_date: string }> = [];
      let submittedCloseOuts: Record<string, CarriedCloseOut> = {};
      if (reportId) {
        const { data: currentNote } = await supabase
          .from('tppo_report_notes')
          .select('reason_note')
          .eq('report_id', reportId)
          .eq('zone', 'collections')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        submittedNote = currentNote?.reason_note ?? null;

        const { data: currentActions } = await supabase
          .from('tppo_report_actions')
          .select(
            'id, item_text, owner_label, due_date, outcome, outcome_note, carried_from_action_id',
          )
          .eq('report_id', reportId)
          .eq('zone', 'collections')
          .order('created_at', { ascending: true });

        submittedActions = (currentActions ?? [])
          .filter((a) => a.carried_from_action_id === null)
          .map((a) => ({
            item_text: a.item_text,
            owner: a.owner_label ?? 'Owner on staff',
            due_date: a.due_date,
          }));

        submittedCloseOuts = Object.fromEntries(
          (currentActions ?? [])
            .filter((a) => a.carried_from_action_id !== null)
            .map((a) => [
              a.carried_from_action_id as string,
              {
                outcome: (a.outcome ?? null) as CarriedCloseOut['outcome'],
                result: a.outcome_note ?? '',
              },
            ]),
        );
      }

      return { priorNote, carriedRows, submittedNote, submittedActions, submittedCloseOuts };
    },
  });

  const carriedRows = narrative.data?.carriedRows ?? [];
  const note = noteDrafts[draftKey] ?? '';
  const actions = actionDrafts[draftKey] ?? [];
  const closeOuts = useMemo(
    () =>
      submitted
        ? (narrative.data?.submittedCloseOuts ?? {})
        : (closeOutDrafts[draftKey] ?? {}),
    [submitted, narrative.data?.submittedCloseOuts, closeOutDrafts, draftKey],
  );

  const verdict =
    data?.below_threshold === null || data?.below_threshold === undefined
      ? '—'
      : data.below_threshold
        ? 'BELOW THRESHOLD'
        : 'ON THRESHOLD';

  const status = data?.status === 'submitted' ? 'Submitted' : 'Draft';

  const today = kampalaToday();
  const isToday = anchor === today;

  const stepBack = () => {
    const d = parseISO(anchor);
    const next =
      granularity === 'day' ? subDays(d, 1) : granularity === 'week' ? subDays(d, 7) : subMonths(d, 1);
    setAnchor(format(next, 'yyyy-MM-dd'));
  };
  const stepForward = () => {
    const d = parseISO(anchor);
    const next =
      granularity === 'day' ? addDays(d, 1) : granularity === 'week' ? addDays(d, 7) : addMonths(d, 1);
    setAnchor(format(next, 'yyyy-MM-dd'));
  };
  const forwardCandidate = (() => {
    const d = parseISO(anchor);
    const next =
      granularity === 'day' ? addDays(d, 1) : granularity === 'week' ? addDays(d, 7) : addMonths(d, 1);
    return format(next, 'yyyy-MM-dd');
  })();
  const nextDisabled = forwardCandidate > today;

  const anchorLabel = format(
    parseISO(anchor),
    granularity === 'day' ? 'EEE dd MMM yyyy' : 'dd MMM yyyy',
  );




  return (
    <div className="w-full space-y-4 overflow-x-hidden pb-28 pt-1">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClose}
            className="h-9 shrink-0 gap-1.5 rounded-lg px-3 font-medium"
            title="Close report and return to dashboard"
          >
            <ArrowLeft className="h-4 w-4 text-muted-foreground" />
            <span className="hidden sm:inline">Back</span>
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-primary">
              <BarChart3 className="h-4 w-4 shrink-0" aria-hidden="true" />
              <p className="text-[11px] font-semibold uppercase tracking-wider">Tenant Ops · portfolio reporting</p>
            </div>
            <h2 className="mt-1 text-base font-bold tracking-tight text-foreground lg:text-lg">Portfolio Performance</h2>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              Collections and rent requests across the selected reporting period.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <div className="w-full sm:w-auto">
            <PeriodToggle value={granularity} onChange={setGranularity} />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleClose}
            className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Close report"
          >
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/60 bg-card p-2.5 shadow-sm sm:flex-nowrap sm:justify-end">
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Previous period"
            onClick={stepBack}
            className="h-11 w-11 sm:h-9 sm:w-9"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="flex-1 text-center text-sm font-medium text-foreground sm:flex-none sm:min-w-[10rem]">
            {anchorLabel}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Next period"
            onClick={stepForward}
            disabled={nextDisabled}
            className="h-11 w-11 sm:h-9 sm:w-9"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAnchor(today)}
            disabled={isToday}
            className="min-h-11 sm:min-h-9"
          >
            Today
          </Button>
          <input
            type="date"
            value={anchor}
            max={today}
            onChange={(e) => {
              if (e.target.value) setAnchor(e.target.value);
            }}
            aria-label="Choose anchor date"
            className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground sm:h-9 sm:w-auto"
          />
        </div>
        {!isToday && (
          <Badge variant="outline" className="text-[11px] font-semibold">Viewing a closed period</Badge>
        )}
      </div>

      <section
        className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card to-card p-4 shadow-sm"
        aria-labelledby="portfolio-period-heading"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-xl bg-primary/15 p-2 text-primary">
              <CalendarRange className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h3
                id="portfolio-period-heading"
                className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                Reporting period
              </h3>
              {isLoading ? (
                <Skeleton className="mt-2 h-5 w-72 max-w-full" />
              ) : (
                <p className="mt-1 break-words text-sm font-bold text-foreground">
                  {periodInWords(granularity, data?.period_start ?? null, data?.period_end ?? null)}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={verdict === 'BELOW THRESHOLD' ? 'destructive' : 'secondary'} className="font-semibold">
              {verdict}
            </Badge>
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 font-semibold text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> {status}
            </span>
          </div>
        </div>
        {isError && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">
              Could not load this period: {(error as Error)?.message ?? 'unknown error'}
            </span>
          </div>
        )}
      </section>

      <TppoPlanDetailTable granularity={granularity} anchor={anchor} />

      <div className="grid gap-4 xl:grid-cols-2">
        <HeadlineA1 report={data} />
        <VarianceA2 report={data} earlier={earlier} />
      </div>

      <ArrearsMovementA2b granularity={granularity} anchor={anchor} />

      <WeeklyArrearsSheet anchor={anchor} />


      <ProjectionA3 granularity={granularity} anchor={anchor} />

      <div className="flex items-start gap-2 border-b border-border/60 pb-2 pt-1">
        <span className="rounded-xl bg-primary/10 p-1.5 text-primary">
          <FileText className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold tracking-tight text-foreground">Management narrative and actions</h3>
          <p className="text-[11px] text-muted-foreground">
            Reasons behind the period figures, plus owned actions carried into the next one.
          </p>
        </div>
      </div>
      <NarrativeCollections
        granularity={granularity}
        submitted={submitted}
        note={note}
        onNoteChange={(value) => setNoteDrafts((prev) => ({ ...prev, [draftKey]: value }))}
        priorNote={narrative.data?.priorNote ?? null}
        submittedNote={narrative.data?.submittedNote ?? null}
        actions={actions}
        onActionsChange={(next) => setActionDrafts((prev) => ({ ...prev, [draftKey]: next }))}
        submittedActions={narrative.data?.submittedActions ?? []}
      />
      <CarriedActions
        submitted={submitted}
        rows={carriedRows}
        closeOuts={closeOuts}
        onChange={(id, patch) =>
          setCloseOutDrafts((prev) => {
            const forPeriod = prev[draftKey] ?? {};
            const existing = forPeriod[id] ?? { outcome: null, result: '' };
            return {
              ...prev,
              [draftKey]: { ...forPeriod, [id]: { ...existing, ...patch } },
            };
          })
        }
      />
      <SubmitGate
        granularity={granularity}
        anchor={anchor}
        periodStart={periodStart}
        periodEnd={periodEnd}
        reportId={reportId}
        submitted={submitted}
        state={{
          note,
          priorNote: narrative.data?.priorNote ?? null,
          actions,
          carriedRows,
          closeOuts,
        }}
        onSubmitted={() => {
          void queryClient.invalidateQueries({ queryKey: ['tppo-report-zone-a'] });
          void queryClient.invalidateQueries({ queryKey: ['tppo-narrative-collections'] });
        }}
      />

      <div className="flex items-start gap-2 border-b border-border/60 pb-2 pt-1">
        <span className="rounded-xl bg-primary/10 p-1.5 text-primary">
          <FileText className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold tracking-tight text-foreground">Past reports</h3>
          <p className="text-[11px] text-muted-foreground">Submitted portfolio reports, newest first.</p>
        </div>
      </div>
      <ReportArchiveList source="tppo" />
    </div>
  );
}
