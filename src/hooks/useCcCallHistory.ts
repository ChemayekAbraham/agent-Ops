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
 *
 * Retrieval note: the attempt rows, their roster rows and their feedback are
 * fetched as separate reads instead of one nested embed with an embedded
 * filter. A single malformed/blocked embed used to fail the whole read, which
 * showed up as an empty History tab even though the records existed.
 */
import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CcOutcome, CcSeverity, CcSubjectType } from '@/hooks/useCcCallingHub';

export interface CcHistoryRow {
  id: string;
  attemptNo: number;
  subjectId: string;
  subjectName: string;
  subjectPhone: string | null;
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
  /** Existing tenant plan context (read-only, same view Missed Days uses). */
  agentName: string | null;
  agentPhone: string | null;
  dailyRepayment: number | null;
  outstandingBalance: number | null;
  planStatus: string | null;
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
}

const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export interface CcHistoryWindow {
  /** Inclusive lower bound (ISO). */
  fromIso: string;
  /** Exclusive upper bound (ISO). */
  toIso: string;
}

/**
 * Every attempt on one subject type inside the window (or the last `days`
 * days when no explicit window is given), newest first. Paged so nothing is
 * silently truncated.
 */
export function useCcCallHistory(subjectType: CcSubjectType, days = 30, window?: CcHistoryWindow) {
  /**
   * The rolling window MUST be quantised, not taken from `Date.now()` on every
   * render. An un-quantised bound produced a new value on each render, which
   * produced a new query key, which triggered a new fetch, which re-rendered —
   * the History tab refetched forever and hammered the database. Anchoring the
   * bound to the start of the local day makes the key stable for the whole day
   * (same records, same meaning) so the query resolves once and then caches.
   */
  const fromIso = useMemo(() => {
    if (window?.fromIso) return window.fromIso;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    midnight.setDate(midnight.getDate() - days);
    return midnight.toISOString();
  }, [window?.fromIso, days]);
  const toIso = window?.toIso ?? null;


  return useQuery({
    queryKey: ['cc-call-history', subjectType, fromIso, toIso],
    queryFn: async (): Promise<CcHistoryRow[]> => {
      // 1. Attempts in the window — flat read, no embeds.
      const attempts: AttemptRecord[] = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        let q = (supabase as any)
          .from('cc_call_attempts')
          .select(
            'id, attempt_no, revealed_at, recorded_at, outcome, channel, source, void_reason, legacy_note, caller_id, cycle_row_id',
          )
          .gte('revealed_at', fromIso);
        if (toIso) q = q.lt('revealed_at', toIso);
        const { data, error } = await q.order('revealed_at', { ascending: false }).range(from, from + page - 1);
        if (error) throw error;
        attempts.push(...((data || []) as AttemptRecord[]));
        if (!data || data.length < page) break;
      }
      if (!attempts.length) return [];

      // 2. Roster rows — gives the subject and the subject type.
      const rowIds = [...new Set(attempts.map((a) => a.cycle_row_id))];
      const rowMap = new Map<string, { subject_type: CcSubjectType; subject_id: string }>();
      for (const slice of chunk(rowIds, 300)) {
        const { data, error } = await (supabase as any)
          .from('cc_cycle_rows')
          .select('id, subject_type, subject_id')
          .in('id', slice);
        if (error) throw error;
        ((data || []) as { id: string; subject_type: CcSubjectType; subject_id: string }[]).forEach((r) =>
          rowMap.set(r.id, { subject_type: r.subject_type, subject_id: r.subject_id }),
        );
      }

      const scoped = attempts.filter((a) => rowMap.get(a.cycle_row_id)?.subject_type === subjectType);
      if (!scoped.length) return [];

      // 3. Feedback (category + note + severity) per attempt.
      const attemptIds = scoped.map((a) => a.id);
      const feedbackMap = new Map<string, { note: string | null; severity: CcSeverity | null; category_id: string | null }>();
      for (const slice of chunk(attemptIds, 300)) {
        const { data, error } = await (supabase as any)
          .from('cc_feedback')
          .select('attempt_id, note, severity, category_id')
          .in('attempt_id', slice);
        if (error) throw error;
        (
          (data || []) as {
            attempt_id: string;
            note: string | null;
            severity: CcSeverity | null;
            category_id: string | null;
          }[]
        ).forEach((f) => {
          if (!feedbackMap.has(f.attempt_id)) feedbackMap.set(f.attempt_id, f);
        });
      }

      const categoryLabels = new Map<string, string>();
      const categoryIds = [...new Set([...feedbackMap.values()].map((f) => f.category_id).filter(Boolean))] as string[];
      if (categoryIds.length) {
        const { data } = await (supabase as any)
          .from('cc_feedback_categories')
          .select('id, label')
          .in('id', categoryIds);
        ((data || []) as { id: string; label: string | null }[]).forEach((c) => {
          if (c.label) categoryLabels.set(c.id, c.label);
        });
      }

      // 4. Names + phones for subjects and officers.
      const subjectIds = [...new Set(scoped.map((a) => rowMap.get(a.cycle_row_id)!.subject_id))];
      const officerIds = [...new Set(scoped.map((a) => a.caller_id).filter(Boolean))] as string[];

      // 5. Existing plan context for tenants (same view Missed Days reads).
      const planBySubject = new Map<
        string,
        { agent_id: string | null; daily_repayment: number; outstanding: number; status: string | null }
      >();
      if (subjectType === 'tenant') {
        for (const slice of chunk(subjectIds, 200)) {
          const { data } = await (supabase as any)
            .from('v_tenant_daily_eligibility')
            .select('tenant_id, agent_id, daily_repayment, total_repayment, amount_repaid, status')
            .in('tenant_id', slice);
          (
            (data || []) as {
              tenant_id: string;
              agent_id: string | null;
              daily_repayment: number | null;
              total_repayment: number | null;
              amount_repaid: number | null;
              status: string | null;
            }[]
          ).forEach((p) => {
            const outstanding = Number(p.total_repayment || 0) - Number(p.amount_repaid || 0);
            const prev = planBySubject.get(p.tenant_id);
            // Same tie-break as the reveal snapshot: largest balance wins.
            if (!prev || outstanding > prev.outstanding) {
              planBySubject.set(p.tenant_id, {
                agent_id: p.agent_id ?? null,
                daily_repayment: Number(p.daily_repayment || 0),
                outstanding,
                status: p.status ?? null,
              });
            }
          });
        }
      }

      const profileIds = [
        ...new Set([
          ...subjectIds,
          ...officerIds,
          ...([...planBySubject.values()].map((p) => p.agent_id).filter(Boolean) as string[]),
        ]),
      ];
      const names = new Map<string, string>();
      const phones = new Map<string, string>();
      for (const slice of chunk(profileIds, 300)) {
        const { data } = await (supabase as any).from('profiles').select('id, full_name, phone').in('id', slice);
        ((data || []) as { id: string; full_name: string | null; phone: string | null }[]).forEach((p) => {
          if (p.full_name) names.set(p.id, p.full_name);
          if (p.phone) phones.set(p.id, p.phone);
        });
      }

      // 6. Latest follow-up per roster row.
      const followUps = new Map<string, { due_at: string; completed_at: string | null }>();
      for (const slice of chunk([...new Set(scoped.map((a) => a.cycle_row_id))], 300)) {
        const { data } = await (supabase as any)
          .from('cc_followups')
          .select('cycle_row_id, due_at, completed_at')
          .in('cycle_row_id', slice)
          .order('due_at', { ascending: false });
        ((data || []) as { cycle_row_id: string; due_at: string; completed_at: string | null }[]).forEach((f) => {
          if (!followUps.has(f.cycle_row_id)) followUps.set(f.cycle_row_id, f);
        });
      }

      return scoped.map((a) => {
        const feedback = feedbackMap.get(a.id) ?? null;
        const subjectId = rowMap.get(a.cycle_row_id)!.subject_id;
        const fu = followUps.get(a.cycle_row_id) ?? null;
        const plan = planBySubject.get(subjectId) ?? null;
        return {
          id: a.id,
          attemptNo: a.attempt_no,
          subjectId,
          subjectName: names.get(subjectId) || 'Unnamed',
          subjectPhone: phones.get(subjectId) ?? null,
          cycleRowId: a.cycle_row_id,
          revealedAt: a.revealed_at,
          recordedAt: a.recorded_at,
          outcome: a.outcome,
          channel: a.channel,
          source: a.source,
          officer: a.caller_id ? names.get(a.caller_id) ?? null : null,
          categoryLabel: feedback?.category_id ? categoryLabels.get(feedback.category_id) ?? null : null,
          severity: feedback?.severity ?? null,
          comment: feedback?.note ?? a.legacy_note ?? null,
          voidReason: a.void_reason,
          followUpDueAt: fu?.due_at ?? null,
          followUpCompletedAt: fu?.completed_at ?? null,
          agentName: plan?.agent_id ? names.get(plan.agent_id) ?? null : null,
          agentPhone: plan?.agent_id ? phones.get(plan.agent_id) ?? null : null,
          dailyRepayment: plan?.daily_repayment ?? null,
          outstandingBalance: plan?.outstanding ?? null,
          planStatus: plan?.status ?? null,
        };
      });
    },
    // Cached long enough that flipping between tabs, or between the report and
    // the list, re-reads nothing; the outcome mutations already invalidate.
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Window changes keep the previous rows on screen instead of flickering.
    placeholderData: keepPreviousData,
  });
}
