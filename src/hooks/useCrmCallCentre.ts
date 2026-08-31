/**
 * Data seam for the CRM Call Centre.
 *
 * ⚠️ UI-ONLY STAGE. Every hook here resolves from `CALL_CENTRE_FIXTURES` — the
 * telephony backend is not wired yet (see `docs`/mem note). The hook signatures,
 * query keys and returned shapes are the real ones, so switching to live data
 * means replacing the body of each `queryFn` and deleting the fixture module.
 * Nothing outside this file knows the data is stubbed.
 *
 * When the voice API lands, the intended sources are:
 *   - `useCallRecords`      → `crm_call_sessions` select (+ joined profile)
 *   - `usePlaceCall`        → `crm-place-call` edge function
 *   - `useSaveCallSummary`  → update of the session's `notes` column
 *   - `useCallHistoryFor`   → `crm_call_sessions` filtered by target
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CallRecord } from '@/lib/callCentre';
import { CALL_CENTRE_FIXTURES } from '@/lib/callCentreFixtures';

/** Flip to false the moment `queryFn` bodies point at Supabase. */
export const CALL_CENTRE_IS_STUBBED = true;

const CALL_RECORDS_KEY = ['crm-call-records'] as const;

/**
 * In-memory store standing in for the table. Module-scoped so a saved summary
 * or a placed call survives navigating between the Call Centre tabs within a
 * session, the way the real table would.
 */
let store: CallRecord[] = CALL_CENTRE_FIXTURES.map((r) => ({ ...r }));

/** Every call, newest first. */
export function useCallRecords() {
  return useQuery({
    queryKey: CALL_RECORDS_KEY,
    queryFn: async (): Promise<CallRecord[]> =>
      [...store].sort((a, b) => new Date(b.calledAt).getTime() - new Date(a.calledAt).getTime()),
    staleTime: 30_000,
  });
}

/** Every call to one person, newest first — powers the summary history panel. */
export function useCallHistoryFor(calleeId: string | null) {
  const { data: all = [], isLoading, error } = useCallRecords();

  const data = useMemo(
    () =>
      calleeId
        ? all
            .filter((r) => r.calleeId === calleeId)
            .sort((a, b) => new Date(b.calledAt).getTime() - new Date(a.calledAt).getTime())
        : [],
    [all, calleeId],
  );

  return { data, isLoading, error };
}

function useInvalidateCallRecords() {
  const qc = useQueryClient();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: CALL_RECORDS_KEY });
  }, [qc]);
}

export interface PlaceCallVars {
  calleeId: string;
  calleeName: string;
  calleePhone: string;
  calleeRole: CallRecord['calleeRole'];
  calleeAvatarUrl?: string | null;
  location?: string | null;
}

/**
 * Place a call.
 *
 * Stubbed: appends an `in_progress` row and returns its id, which is what the
 * drawer needs to attach a summary to. The real implementation invokes
 * `crm-place-call`, and because that rings the *staff* handset first, success
 * means "your phone is about to ring" — not "the customer is connected".
 */
export function usePlaceCall() {
  const invalidate = useInvalidateCallRecords();

  return useMutation({
    mutationFn: async (vars: PlaceCallVars): Promise<{ callId: string }> => {
      const callId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      store = [
        {
          id: callId,
          calleeId: vars.calleeId,
          calleeName: vars.calleeName,
          calleePhone: vars.calleePhone,
          calleeAvatarUrl: vars.calleeAvatarUrl ?? null,
          calleeRole: vars.calleeRole,
          location: vars.location ?? null,
          status: 'bridged',
          hangupCause: null,
          durationSeconds: null,
          calledAt: new Date().toISOString(),
          staffId: null,
          staffName: 'You',
          summary: null,
        },
        ...store,
      ];
      invalidate();
      return { callId };
    },
  });
}

export interface EndCallVars {
  callId: string;
  /** Seconds the drawer actually spent connected. */
  durationSeconds: number;
  /** How the staff member says it went. */
  outcome: 'answered' | 'rejected' | 'not_reachable';
}

/**
 * Settle a call that the drawer just finished.
 *
 * Stubbed: writes status/cause/duration exactly as the voice callback would, so
 * `deriveOutcome` reads it through the same path as a provider-written row.
 */
export function useEndCall() {
  const invalidate = useInvalidateCallRecords();

  return useMutation({
    mutationFn: async (vars: EndCallVars): Promise<void> => {
      const statusFor: Record<EndCallVars['outcome'], { status: string; cause: string | null }> = {
        answered: { status: 'completed', cause: 'NORMAL_CLEARING' },
        rejected: { status: 'completed', cause: 'CALL_REJECTED' },
        not_reachable: { status: 'no_answer', cause: 'NO_ANSWER' },
      };
      const mapped = statusFor[vars.outcome];

      store = store.map((r) =>
        r.id === vars.callId
          ? {
              ...r,
              status: mapped.status,
              hangupCause: mapped.cause,
              // Only an answered call has talk time; the others must stay 0 so
              // they never enter the average-talk-time numerator.
              durationSeconds: vars.outcome === 'answered' ? Math.max(0, Math.round(vars.durationSeconds)) : 0,
            }
          : r,
      );
      invalidate();
    },
  });
}

export interface SaveSummaryVars {
  callId: string;
  summary: string;
}

/** Save the staff member's call summary onto the call row. */
export function useSaveCallSummary() {
  const invalidate = useInvalidateCallRecords();

  return useMutation({
    mutationFn: async (vars: SaveSummaryVars): Promise<void> => {
      const trimmed = vars.summary.trim();
      store = store.map((r) => (r.id === vars.callId ? { ...r, summary: trimmed || null } : r));
      invalidate();
    },
  });
}

/**
 * Which person the People table has selected for the summary-history panel.
 * Kept here so Overview's recall list and the People table can drive the same
 * drawer without prop-drilling through the dashboard page.
 */
export function useCallCentreSelection() {
  const [selectedCalleeId, setSelectedCalleeId] = useState<string | null>(null);
  return { selectedCalleeId, setSelectedCalleeId };
}
