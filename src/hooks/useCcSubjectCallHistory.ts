/**
 * Call history for ONE calling subject.
 *
 * Read-only over the same `cc_*` spine as `useCcCallHistory` (attempts →
 * roster rows → feedback → categories), just scoped to a single subject so the
 * details view can show that person's calls without pulling the whole rolling
 * window. It creates no call record, no second calling system and no new
 * arithmetic.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CcOutcome, CcSeverity, CcSubjectType } from '@/hooks/useCcCallingHub';

export interface CcSubjectCall {
  id: string;
  attemptNo: number;
  revealedAt: string;
  recordedAt: string | null;
  outcome: CcOutcome | null;
  channel: string | null;
  officerId: string | null;
  officerName: string | null;
  categoryLabel: string | null;
  severity: CcSeverity | null;
  comment: string | null;
  voidReason: string | null;
  /** Feedback record behind the comment, so a tracked edit can target it. */
  feedbackId: string | null;
  categoryId: string | null;
}

export function useCcSubjectCallHistory(
  subjectType: CcSubjectType,
  subjectId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ['cc-subject-call-history', subjectType, subjectId],
    enabled: enabled && !!subjectId,
    staleTime: 30_000,
    queryFn: async (): Promise<CcSubjectCall[]> => {
      const client = supabase as any;

      // Roster rows for this subject — every cycle it has ever appeared in.
      const { data: rows, error: rowErr } = await client
        .from('cc_cycle_rows')
        .select('id')
        .eq('subject_type', subjectType)
        .eq('subject_id', subjectId);
      if (rowErr) throw rowErr;
      const rowIds = ((rows || []) as { id: string }[]).map((r) => r.id);
      if (!rowIds.length) return [];

      const { data: attempts, error: attErr } = await client
        .from('cc_call_attempts')
        .select('id, attempt_no, revealed_at, recorded_at, outcome, channel, void_reason, caller_id')
        .in('cycle_row_id', rowIds)
        .order('revealed_at', { ascending: false })
        .limit(100);
      if (attErr) throw attErr;
      const list = (attempts || []) as {
        id: string;
        attempt_no: number | null;
        revealed_at: string;
        recorded_at: string | null;
        outcome: CcOutcome | null;
        channel: string | null;
        void_reason: string | null;
        caller_id: string | null;
      }[];
      if (!list.length) return [];

      const attemptIds = list.map((a) => a.id);
      const { data: feedback } = await client
        .from('cc_feedback')
        .select('id, attempt_id, note, severity, category_id')
        .in('attempt_id', attemptIds);
      const fbMap = new Map<
        string,
        { id: string; note: string | null; severity: CcSeverity | null; category_id: string | null }
      >();
      (
        (feedback || []) as {
          id: string;
          attempt_id: string;
          note: string | null;
          severity: CcSeverity | null;
          category_id: string | null;
        }[]
      ).forEach((f) => {
        if (!fbMap.has(f.attempt_id)) fbMap.set(f.attempt_id, f);
      });

      const categoryIds = [...new Set([...fbMap.values()].map((f) => f.category_id).filter(Boolean))] as string[];
      const catMap = new Map<string, string>();
      if (categoryIds.length) {
        const { data: cats } = await client
          .from('cc_feedback_categories')
          .select('id, label')
          .in('id', categoryIds);
        ((cats || []) as { id: string; label: string | null }[]).forEach((c) => {
          if (c.label) catMap.set(c.id, c.label);
        });
      }

      const officerIds = [...new Set(list.map((a) => a.caller_id).filter(Boolean))] as string[];
      const officerMap = new Map<string, string>();
      if (officerIds.length) {
        const { data: people } = await client.from('profiles').select('id, full_name').in('id', officerIds);
        ((people || []) as { id: string; full_name: string | null }[]).forEach((p) => {
          if (p.full_name) officerMap.set(p.id, p.full_name);
        });
      }

      return list.map((a) => {
        const fb = fbMap.get(a.id) ?? null;
        return {
          id: a.id,
          attemptNo: Number(a.attempt_no ?? 1),
          revealedAt: a.revealed_at,
          recordedAt: a.recorded_at,
          outcome: a.outcome,
          channel: a.channel,
          officerId: a.caller_id,
          officerName: a.caller_id ? officerMap.get(a.caller_id) ?? null : null,
          categoryLabel: fb?.category_id ? catMap.get(fb.category_id) ?? null : null,
          severity: fb?.severity ?? null,
          comment: fb?.note ?? null,
          voidReason: a.void_reason,
          feedbackId: fb?.id ?? null,
          categoryId: fb?.category_id ?? null,
        };
      });
    },
  });
}
