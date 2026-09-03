/**
 * Shared call history for the `cc_*` calling spine.
 *
 * This is the SAME source of truth the Calling Hub writes to: every attempt row
 * in `cc_call_attempts` (opened by a reveal, closed by `cc_record_unreached`,
 * `cc_record_engaged`, `cc_record_callback` or `cc_void_attempt`) together with
 * its `cc_feedback` comment/category and any `cc_followups` booked from it.
 *
 * It creates NO new call record and writes nothing — read-only. Calls made from
 * the Calling Hub and from the Calling Center therefore appear as one
 * continuous history, before and after the Center launch.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CcOutcome, CcSeverity, CcSubjectType } from '@/hooks/useCcCallingHub';

export interface CcHistoryRow {
  id: string;
  attemptNo: number;
  subjectId: string;
  subjectName: string;
  cycleRowId: string;
  /** Reveal time — when the officer picked the number up. */
  revealedAt: string;
  /** Outcome time. Null while the attempt is still open (unrecorded). */
  recordedAt: string | null;
  outcome: CcOutcome | null;
  channel: string | null;
  source: string | null;
  officer: string | null;
  categoryLabel: string | null;
  severity: CcSeverity | null;
  comment: string | null;
  voidReason: string | null;
  followUpDueAt: string | null;
  followUpCompletedAt: string | null;
}

export const CC_OUTCOME_LABEL: Record<CcOutcome, string> = {
  engaged: 'Engaged (answered)',
  callback_booked: 'Callback booked',
  no_answer: 'No answer',
  phone_off: 'Phone off',
  wrong_number: 'Wrong number',
  refused: 'Refused',
};

/** Answered/received vs unanswered, using the Hub's own outcome vocabulary. */
export const isAnsweredOutcome = (o: CcOutcome | null) => o === 'engaged' || o === 'callback_booked';

interface AttemptRecord {
  id: string;
  attempt_no: number;
  revealed_at: string;
  recorded_at: string | null;
  outcome: CcOutcome | null;
  channel: string | null;
  source: string | null;
  void_reason: string | null;
  legacy_note: string | null;
  caller_id: string | null;
  cycle_row_id: string;
  cc_cycle_rows: { subject_type: CcSubjectType; subject_id: string } | null;
  cc_feedback:
    | {
        note: string | null;
        severity: CcSeverity | null;
        cc_feedback_categories: { label: string | null } | null;
      }[]
    | null;
}

/**
 * Every attempt on one subject type inside the last `days` days, newest first.
 * Paged so nothing is silently truncated.
 */
export function useCcCallHistory(subjectType: CcSubjectType, days = 30) {
  return useQuery({
    queryKey: ['cc-call-history', subjectType, days],
    queryFn: async (): Promise<CcHistoryRow[]> => {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();

      const attempts: AttemptRecord[] = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        const { data, error } = await (supabase as any)
          .from('cc_call_attempts')
          .select(
            'id, attempt_no, revealed_at, recorded_at, outcome, channel, source, void_reason, legacy_note, caller_id, cycle_row_id, cc_cycle_rows!inner(subject_type, subject_id), cc_feedback(note, severity, cc_feedback_categories(label))',
          )
          .eq('cc_cycle_rows.subject_type', subjectType)
          .gte('revealed_at', since)
          .order('revealed_at', { ascending: false })
          .range(from, from + page - 1);
        if (error) throw error;
        attempts.push(...((data || []) as AttemptRecord[]));
        if (!data || data.length < page) break;
      }

      const subjectIds = [...new Set(attempts.map((a) => a.cc_cycle_rows?.subject_id).filter(Boolean))] as string[];
      const officerIds = [...new Set(attempts.map((a) => a.caller_id).filter(Boolean))] as string[];
      const rowIds = [...new Set(attempts.map((a) => a.cycle_row_id))];

      const names = new Map<string, string>();
      const ids = [...new Set([...subjectIds, ...officerIds])];
      for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        if (!slice.length) break;
        const { data } = await (supabase as any)
          .from('profiles')
          .select('id, full_name')
          .in('id', slice);
        ((data || []) as { id: string; full_name: string | null }[]).forEach((p) => {
          if (p.full_name) names.set(p.id, p.full_name);
        });
      }

      const followUps = new Map<string, { due_at: string; completed_at: string | null }>();
      for (let i = 0; i < rowIds.length; i += 500) {
        const slice = rowIds.slice(i, i + 500);
        if (!slice.length) break;
        const { data } = await (supabase as any)
          .from('cc_followups')
          .select('cycle_row_id, due_at, completed_at')
          .in('cycle_row_id', slice)
          .order('due_at', { ascending: false });
        ((data || []) as { cycle_row_id: string; due_at: string; completed_at: string | null }[]).forEach((f) => {
          if (!followUps.has(f.cycle_row_id)) followUps.set(f.cycle_row_id, f);
        });
      }

      return attempts.map((a) => {
        const feedback = a.cc_feedback?.[0] ?? null;
        const subjectId = a.cc_cycle_rows?.subject_id ?? '';
        const fu = followUps.get(a.cycle_row_id) ?? null;
        return {
          id: a.id,
          attemptNo: a.attempt_no,
          subjectId,
          subjectName: names.get(subjectId) || 'Unnamed',
          cycleRowId: a.cycle_row_id,
          revealedAt: a.revealed_at,
          recordedAt: a.recorded_at,
          outcome: a.outcome,
          channel: a.channel,
          source: a.source,
          officer: a.caller_id ? names.get(a.caller_id) ?? null : null,
          categoryLabel: feedback?.cc_feedback_categories?.label ?? null,
          severity: feedback?.severity ?? null,
          comment: feedback?.note ?? a.legacy_note ?? null,
          voidReason: a.void_reason,
          followUpDueAt: fu?.due_at ?? null,
          followUpCompletedAt: fu?.completed_at ?? null,
        };
      });
    },
    staleTime: 30_000,
  });
}
