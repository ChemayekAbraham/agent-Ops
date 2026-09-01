import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import {
  MIN_NOTE_CHARS,
  actionIsComplete,
  noteLength,
  noteMatchesPrior,
  type DraftAction,
} from './NarrativeCollections';
import {
  carriedCloseOutComplete,
  type CarriedActionRow,
  type CarriedCloseOut,
} from './CarriedActions';
import type { TppoGranularity } from './PeriodToggle';

export interface SubmitGateState {
  note: string;
  priorNote: string | null;
  actions: DraftAction[];
  carriedRows: CarriedActionRow[];
  closeOuts: Record<string, CarriedCloseOut>;
}

export interface SubmitCondition {
  key: string;
  test: (state: SubmitGateState) => boolean;
  message: string;
}

/**
 * Extend this array to add later zones' conditions. The gate itself never changes.
 */
export const SUBMIT_CONDITIONS: SubmitCondition[] = [
  {
    key: 'collections_note',
    test: (s) =>
      noteLength(s.note) >= MIN_NOTE_CHARS && !noteMatchesPrior(s.note, s.priorNote),
    message: `The collections explanation must be at least ${MIN_NOTE_CHARS} characters and must differ from the previous period's note.`,
  },
  {
    key: 'collections_action',
    test: (s) => s.actions.some(actionIsComplete),
    message:
      'At least one action for the next period needs text, an owner and a due date.',
  },
  {
    key: 'carried_close_out',
    test: (s) => s.carriedRows.every((r) => carriedCloseOutComplete(s.closeOuts[r.id])),
    message: 'Every carried action needs an outcome and a one-line result.',
  },
];

interface SubmitGateProps {
  granularity: TppoGranularity;
  anchor: string;
  periodStart: string | null;
  periodEnd: string | null;
  reportId: string | null;
  submitted: boolean;
  state: SubmitGateState;
  onSubmitted: () => void;
}

export function SubmitGate({
  granularity,
  anchor,
  periodStart,
  periodEnd,
  reportId,
  submitted,
  state,
  onSubmitted,
}: SubmitGateProps) {
  const [busy, setBusy] = useState(false);
  const [notifyFailed, setNotifyFailed] = useState(false);
  const failing = SUBMIT_CONDITIONS.filter((c) => !c.test(state));
  const canSubmit = failing.length === 0 && !submitted && Boolean(periodStart);

  const notifyNotice = notifyFailed ? (
    <p className="text-xs text-amber-600">
      The reviewer notification did not send. The submission stands.
    </p>
  ) : null;

  if (submitted) {
    return (
      <Card>
        <CardContent className="space-y-2 py-4 text-sm text-muted-foreground">
          <p>This report has been submitted and is read-only.</p>
          {notifyNotice}
        </CardContent>
      </Card>
    );
  }

  const handleSubmit = async () => {
    if (busy) return;
    if (!canSubmit || !periodStart || !periodEnd) return;
    setBusy(true);

    try {
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth.user?.id;
      if (!userId) throw new Error('No signed-in user');

      let targetReportId = reportId;
      if (!targetReportId) {
        const { data: snapshot, error: snapshotError } = await supabase
          .from('tppo_period_snapshots')
          .select('id')
          .eq('granularity', granularity)
          .eq('period_start', periodStart)
          .maybeSingle();
        if (snapshotError) throw snapshotError;
        if (!snapshot) throw new Error('No period snapshot exists for this period yet');
        const { data: inserted, error: insertError } = await supabase
          .from('tppo_reports')
          .insert({
            granularity,
            period_start: periodStart,
            period_end: periodEnd,
            snapshot_id: snapshot.id,
            created_by: userId,
          })
          .select('id')
          .single();
        if (insertError) throw insertError;
        targetReportId = inserted.id;
      }

      const { error: noteError } = await supabase.from('tppo_report_notes').insert({
        report_id: targetReportId,
        zone: 'collections',
        reason_note: state.note.trim(),
        created_by: userId,
      });
      if (noteError) throw noteError;

      const actionRows = state.actions.filter(actionIsComplete).map((a) => ({
        report_id: targetReportId as string,
        zone: 'collections',
        item_text: a.item_text.trim(),
        owner_staff_id: a.owner_staff_id,
        owner_label: a.owner_staff_id ? null : a.owner_label.trim(),
        due_date: a.due_date,
        created_by: userId,
      }));
      if (actionRows.length > 0) {
        const { error: actionsError } = await supabase
          .from('tppo_report_actions')
          .insert(actionRows);
        if (actionsError) throw actionsError;
      }

      const closeOutRows = state.carriedRows.map((row) => {
        const closeOut = state.closeOuts[row.id];
        return {
          report_id: targetReportId as string,
          zone: 'collections',
          item_text: row.item_text,
          owner_label: row.owner,
          due_date: row.due_date,
          carried_from_action_id: row.id,
          outcome: closeOut.outcome,
          outcome_note: closeOut.result.trim(),
          closed_at: new Date().toISOString(),
          closed_by: userId,
          created_by: userId,
        };
      });
      if (closeOutRows.length > 0) {
        const { error: closeOutError } = await supabase
          .from('tppo_report_actions')
          .insert(closeOutRows);
        if (closeOutError) throw closeOutError;
      }

      const { error: statusError } = await supabase
        .from('tppo_reports')
        .update({
          status: 'submitted',
          submitted_at: new Date().toISOString(),
          submitted_by: userId,
        })
        .eq('id', targetReportId);
      if (statusError) throw statusError;

      const { error: freezeError } = await supabase.rpc('tppo_freeze_period', {
        p_granularity: granularity,
        p_anchor: anchor,
        p_finalise: true,
      });
      if (freezeError) throw freezeError;

      toast.success('Report submitted. The period denominator is frozen.');
      onSubmitted();
    } catch (err) {
      toast.error((err as Error)?.message ?? 'Could not submit this report');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1 text-sm">
          {failing.length === 0 ? (
            <p className="text-muted-foreground">
              All submission conditions pass. Submitting freezes this period's denominator.
            </p>
          ) : (
            <>
              <p className="font-medium text-foreground">
                Submission is blocked until these are resolved:
              </p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                {failing.map((c) => (
                  <li key={c.key}>{c.message}</li>
                ))}
              </ul>
            </>
          )}
        </div>
        <Button type="button" disabled={!canSubmit || busy} onClick={handleSubmit}>
          {busy ? 'Submitting…' : 'Submit report'}
        </Button>
      </CardContent>
    </Card>
  );
}
