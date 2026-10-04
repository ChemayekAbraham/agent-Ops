/**
 * use30mAwareness — save and query 30M Rent Plan awareness tracking rows.
 *
 * Additive layer: does not touch any cc_* table, hook, or calling workflow.
 * The mutation inserts one row into tops_30m_awareness per answered call.
 * The query fetches stats for the weekly forwarding report.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

// ---- types ------------------------------------------------------------------

export type AwarenessBefore = 'knew' | 'heard' | 'did_not_know';
export type ExplanationGiven = 'yes' | 'partly' | 'no';
export type UnderstandingAfter = 'understood' | 'partly_understood' | 'did_not_understand';
export type AwarenessInterest = 'apply_now' | 'interested_later' | 'not_interested' | 'not_sure';

export interface Awareness30mInput {
  /** Soft-reference to the cc_call_attempts.id — no FK, may be null. */
  ccCallId: string | null;
  /** The tenant's user profile id. */
  tenantUserId: string;
  /** The logged-in officer's user id (auth.uid()). Required by RLS policy. */
  recordedBy: string;
  /** Q1 */
  awarenessBefore: AwarenessBefore;
  /** Q2 */
  explanationGiven: ExplanationGiven;
  /** Q3 */
  understandingAfter: UnderstandingAfter;
  /** Q4 */
  interest: AwarenessInterest;
  /** Tenant's Rent Plan limit at call time (UGX). Null if unknown. */
  rentPlanLimitUgx: number | null;
}

export interface Awareness30mStats {
  totalReached: number;
  awarenessBefore: { knew: number; heard: number; didNotKnow: number };
  explanationGiven: { yes: number; partly: number; no: number };
  understandingAfter: { understood: number; partlyUnderstood: number; didNotUnderstand: number };
  interest: { applyNow: number; later: number; notInterested: number; notSure: number };
}

// ---- helpers ----------------------------------------------------------------

function mapStats(row: Record<string, number>): Awareness30mStats {
  return {
    totalReached: row.total_reached ?? 0,
    awarenessBefore: {
      knew: row.awareness_knew ?? 0,
      heard: row.awareness_heard ?? 0,
      didNotKnow: row.awareness_did_not_know ?? 0,
    },
    explanationGiven: {
      yes: row.explanation_yes ?? 0,
      partly: row.explanation_partly ?? 0,
      no: row.explanation_no ?? 0,
    },
    understandingAfter: {
      understood: row.understanding_understood ?? 0,
      partlyUnderstood: row.understanding_partly ?? 0,
      didNotUnderstand: row.understanding_did_not_understand ?? 0,
    },
    interest: {
      applyNow: row.interest_apply_now ?? 0,
      later: row.interest_later ?? 0,
      notInterested: row.interest_not_interested ?? 0,
      notSure: row.interest_not_sure ?? 0,
    },
  };
}

// ---- mutation ---------------------------------------------------------------

/**
 * Returns a mutation that saves one 30M awareness row.
 *
 * The calling and hang-up workflow is NOT affected — this mutation is called
 * separately, after the existing `RecordOutcomeDialog` has already closed.
 */
export function useSave30mAwareness() {
  return useMutation({
    mutationFn: async (input: Awareness30mInput) => {
      const { error } = await anyDb.from('tops_30m_awareness').insert({
        cc_call_id: input.ccCallId,
        tenant_user_id: input.tenantUserId,
        recorded_by: input.recordedBy,
        awareness_before: input.awarenessBefore,
        explanation_given: input.explanationGiven,
        understanding_after: input.understandingAfter,
        interest: input.interest,
        rent_plan_limit_ugx: input.rentPlanLimitUgx,
      });
      if (error) throw new Error(error.message);
    },
  });
}

// ---- query (for the weekly report) -----------------------------------------

/**
 * Fetches aggregate 30M awareness stats for a time window.
 * Used by the Weekly Forwarding Report UI and PDF export.
 */
export function use30mAwarenessStats(fromIso: string, toIso: string) {
  return useQuery<Awareness30mStats>({
    queryKey: ['30m-awareness-stats', fromIso, toIso],
    queryFn: async () => {
      const { data, error } = await anyDb.rpc('tops_30m_awareness_stats', {
        p_from: fromIso,
        p_to: toIso,
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return mapStats({});
      return mapStats(row as Record<string, number>);
    },
    staleTime: 60_000,
  });
}
