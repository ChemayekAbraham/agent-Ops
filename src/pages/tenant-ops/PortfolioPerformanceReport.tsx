import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PeriodToggle, type TppoGranularity } from '@/components/tenant-ops/tppo/PeriodToggle';
import { HeadlineA1 } from '@/components/tenant-ops/tppo/HeadlineA1';
import { VarianceA2 } from '@/components/tenant-ops/tppo/VarianceA2';
import { ProjectionA3 } from '@/components/tenant-ops/tppo/ProjectionA3';
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


export default function PortfolioPerformanceReport() {
  // Each period state holds its own record: the query key is the sole carrier of
  // state, so nothing (figure, text or draft) crosses between Daily/Weekly/Monthly.
  const [granularity, setGranularity] = useState<TppoGranularity>('day');
  const anchor = kampalaToday();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tppo-report-zone-a', granularity, anchor],
    queryFn: async (): Promise<ZoneAReport> => {
      const { data: rpcData, error: rpcError } = await supabase.rpc('tppo_get_report_zone_a', {
        p_granularity: granularity,
        p_anchor: anchor,
      });
      if (rpcError) throw rpcError;
      return (rpcData ?? {}) as unknown as ZoneAReport;
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


  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
      <PeriodToggle value={granularity} onChange={setGranularity} />

      <Card>
        <CardHeader className="space-y-2">
          <CardTitle className="text-xl font-semibold tracking-wide">
            PERFORMANCE REPORT
          </CardTitle>
          {isLoading ? (
            <Skeleton className="h-5 w-72" />
          ) : (
            <div className="space-y-1 text-sm">
              <p className="text-foreground">
                {periodInWords(granularity, data?.period_start ?? null, data?.period_end ?? null)}
              </p>
              <p className="font-medium text-foreground">{verdict}</p>
              <p className="text-muted-foreground">{status}</p>
            </div>
          )}
          {isError && (
            <p className="text-sm text-destructive">
              Could not load this period: {(error as Error)?.message ?? 'unknown error'}
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <HeadlineA1 report={data} />
          <VarianceA2 report={data} />
          <ProjectionA3 granularity={granularity} anchor={anchor} />
          <NarrativeCollections
            granularity={granularity}
            submitted={submitted}
            note={note}
            onNoteChange={(value) => setNoteDrafts((prev) => ({ ...prev, [draftKey]: value }))}
            priorNote={narrative.data?.priorNote ?? null}
            submittedNote={narrative.data?.submittedNote ?? null}
            actions={actions}
            onActionsChange={(next) =>
              setActionDrafts((prev) => ({ ...prev, [draftKey]: next }))
            }
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

        </CardContent>
      </Card>
    </div>
  );
}
