/**
 * Data seam for the CRM Call Centre — now live.
 *
 * Every Call Centre component reads from this file and nothing else. Sources:
 *   - `useCallRecords`      → `crm_call_sessions_feed` RPC
 *   - `useCallRoster`       → `crm_call_roster_page` RPC (real people, 5 audiences)
 *   - `usePlaceCall`        → `crm-place-call` edge function (rings the STAFF leg first)
 *   - `useCallSession`      → polls the row so "answered" comes from Africa's
 *                             Talking, not from a staff member clicking a button
 *   - `useSaveCallSummary`  → `crm_save_call_summary` RPC (the only column staff may write)
 *   - `useCallHistoryFor`   → `crm_call_sessions_feed` filtered by target
 *
 * Telephony facts (status, hangup cause, duration, cost, recording) are written
 * only by the edge functions under the service role. The frontend never writes
 * telephony state.
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  CALLEE_ROLES,
  deriveOutcome,
  type CalleeRole,
  type CallOutcome,
  type CallRecord,
} from '@/lib/callCentre';

/** The voice API is wired; the dialer no longer shows the "not connected" notice. */
export const CALL_CENTRE_IS_STUBBED = false;

const CALL_RECORDS_KEY = ['crm-call-records'] as const;
const CALL_ROSTER_KEY = ['crm-call-roster'] as const;

const asRole = (raw: unknown): CalleeRole =>
  CALLEE_ROLES.includes(raw as CalleeRole) ? (raw as CalleeRole) : 'tenant';

interface FeedRow {
  id: string;
  target_user_id: string | null;
  target_name: string | null;
  target_phone_masked: string | null;
  target_role: string | null;
  target_location: string | null;
  status: string | null;
  hangup_cause: string | null;
  duration_seconds: number | null;
  created_at: string;
  staff_id: string | null;
  staff_name: string | null;
  summary: string | null;
}

const toCallRecord = (row: FeedRow): CallRecord => ({
  id: row.id,
  // A call with no resolved person still needs a stable grouping key.
  calleeId: row.target_user_id ?? `unknown-${row.id}`,
  calleeName: row.target_name?.trim() || 'Unknown',
  calleePhone: row.target_phone_masked ?? '—',
  calleeAvatarUrl: null,
  calleeRole: asRole(row.target_role),
  location: row.target_location,
  status: row.status ?? 'unknown',
  hangupCause: row.hangup_cause,
  durationSeconds: row.duration_seconds,
  calledAt: row.created_at,
  staffId: row.staff_id,
  staffName: row.staff_name,
  summary: row.summary,
});

/** Every call in the trailing window, newest first. */
export function useCallRecords(days = 30) {
  return useQuery({
    queryKey: [...CALL_RECORDS_KEY, days],
    queryFn: async (): Promise<CallRecord[]> => {
      const { data, error } = await supabase.rpc('crm_call_sessions_feed', {
        p_days: days,
        p_limit: 2000,
        p_target_user_id: null,
      });
      if (error) throw error;
      return ((data ?? []) as FeedRow[]).map(toCallRecord);
    },
    staleTime: 30_000,
  });
}

/** Every call to one person, newest first — powers the summary history panel. */
export function useCallHistoryFor(calleeId: string | null) {
  const query = useQuery({
    queryKey: ['crm-call-history', calleeId],
    enabled: !!calleeId,
    queryFn: async (): Promise<CallRecord[]> => {
      const { data, error } = await supabase.rpc('crm_call_sessions_feed', {
        p_days: 365,
        p_limit: 500,
        p_target_user_id: calleeId,
      });
      if (error) throw error;
      return ((data ?? []) as FeedRow[]).map(toCallRecord);
    },
    staleTime: 30_000,
  });

  return { data: query.data ?? [], isLoading: query.isLoading, error: query.error };
}

/* ------------------------------------------------------------------ *
 * Roster — real people, five audiences
 * ------------------------------------------------------------------ */

export interface RosterPerson {
  calleeId: string;
  name: string;
  /** Masked for the table. The full number is resolved server-side when dialling. */
  phone: string;
  hasPhone: boolean;
  avatarUrl: string | null;
  role: CalleeRole;
  location: string | null;
  status: CallOutcome | null;
  calledAt: string | null;
  recalledAt: string | null;
  totalCalls: number;
  summaries: number;
  lastCallId: string | null;
}

interface RosterRow {
  person_id: string;
  name: string | null;
  phone_masked: string | null;
  has_phone: boolean | null;
  primary_role: string | null;
  location: string | null;
  avatar_url: string | null;
  total_calls: number | null;
  summaries: number | null;
  first_called_at: string | null;
  last_called_at: string | null;
  last_status: string | null;
  last_hangup_cause: string | null;
  last_duration_seconds: number | null;
  last_call_id: string | null;
  total_rows: number | null;
}

/**
 * Real people the Call Centre can ring, paged server-side.
 *
 * Each person carries exactly one primary audience (employee > partner >
 * landlord > agent > tenant) so the doughnut cannot double-count them.
 */
export function useCallRoster(options: { limit?: number } = {}) {
  const limit = options.limit ?? 200;

  const query = useQuery({
    queryKey: [...CALL_ROSTER_KEY, limit],
    queryFn: async (): Promise<{ rows: RosterPerson[]; total: number }> => {
      const { data, error } = await supabase.rpc('crm_call_roster_page', {
        p_search: null,
        p_role: null,
        p_limit: limit,
        p_offset: 0,
      });
      if (error) throw error;

      const raw = (data ?? []) as RosterRow[];
      return {
        total: Number(raw[0]?.total_rows ?? raw.length),
        rows: raw.map((r) => ({
          calleeId: r.person_id,
          name: r.name?.trim() || 'Unnamed user',
          phone: r.phone_masked ?? '—',
          hasPhone: r.has_phone === true,
          avatarUrl: r.avatar_url,
          role: asRole(r.primary_role),
          location: r.location,
          status:
            r.last_call_id
              ? deriveOutcome({
                  status: r.last_status ?? 'unknown',
                  hangupCause: r.last_hangup_cause,
                  durationSeconds: r.last_duration_seconds,
                })
              : null,
          calledAt: r.first_called_at,
          recalledAt:
            r.last_called_at && r.last_called_at !== r.first_called_at ? r.last_called_at : null,
          totalCalls: Number(r.total_calls ?? 0),
          summaries: Number(r.summaries ?? 0),
          lastCallId: r.last_call_id,
        })),
      };
    },
    staleTime: 60_000,
  });

  return { ...query, rows: query.data?.rows ?? [], total: query.data?.total ?? 0 };
}

function useInvalidateCallRecords() {
  const qc = useQueryClient();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: CALL_RECORDS_KEY });
    qc.invalidateQueries({ queryKey: CALL_ROSTER_KEY });
  }, [qc]);
}

/* ------------------------------------------------------------------ *
 * Placing a call
 * ------------------------------------------------------------------ */

export interface PlaceCallVars {
  calleeId: string;
  calleeName: string;
  calleePhone: string;
  calleeRole: CallRecord['calleeRole'];
  calleeAvatarUrl?: string | null;
  location?: string | null;
}

/**
 * Place a call through `crm-place-call`.
 *
 * Africa's Talking rings the STAFF handset first, so a resolved promise means
 * "your handset is about to ring" — not "the customer is connected".
 */
export function usePlaceCall() {
  const invalidate = useInvalidateCallRecords();

  return useMutation({
    mutationFn: async (vars: PlaceCallVars): Promise<{ callId: string; message: string }> => {
      const { data, error } = await supabase.functions.invoke('crm-place-call', {
        body: {
          targetUserId: vars.calleeId.startsWith('unknown-') ? null : vars.calleeId,
          targetName: vars.calleeName,
          targetRole: vars.calleeRole,
          targetLocation: vars.location ?? null,
        },
      });
      if (error) throw error;
      const payload = data as { callId?: string; error?: string; message?: string } | null;
      if (!payload?.callId) throw new Error(payload?.error ?? 'could_not_place_call');
      invalidate();
      return {
        callId: payload.callId,
        message: payload.message ?? 'Your handset is about to ring.',
      };
    },
  });
}

export interface CallSessionState {
  status: string;
  hangupCause: string | null;
  durationSeconds: number | null;
  /** True once Africa's Talking reports the staff leg answered and is bridged. */
  bridged: boolean;
  /** True once the provider reported a terminal state. */
  settled: boolean;
}

const LIVE = new Set(['initiating', 'queued', 'ringing', 'ringing_staff', 'bridged', 'in_progress', 'active']);

/**
 * Poll the telephony row while a call is live.
 *
 * This is what makes "they answered" automatic: the answer comes from the
 * provider's own callback, never from a staff member asserting it.
 */
export function useCallSession(callId: string | null, enabled: boolean) {
  const query = useQuery({
    queryKey: ['crm-call-session', callId],
    enabled: !!callId && enabled,
    refetchInterval: enabled ? 2000 : false,
    queryFn: async (): Promise<CallSessionState | null> => {
      if (!callId) return null;
      const { data, error } = await supabase
        .from('crm_call_sessions')
        .select('status, hangup_cause, duration_seconds')
        .eq('id', callId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const status = (data.status ?? '').toLowerCase();
      return {
        status,
        hangupCause: data.hangup_cause,
        durationSeconds: data.duration_seconds,
        bridged: status === 'bridged' || status === 'active' || status === 'in_progress',
        settled: !LIVE.has(status),
      };
    },
  });

  return query.data ?? null;
}

/* ------------------------------------------------------------------ *
 * Outcome overrides + summary
 * ------------------------------------------------------------------ */

export interface EndCallVars {
  callId: string;
  durationSeconds: number;
  outcome: 'answered' | 'rejected' | 'not_reachable';
}

/**
 * Manual failure override.
 *
 * The provider is the authority on how a call ended, so this only nudges the
 * local caches to refetch — it never writes telephony state, which the frontend
 * is not permitted to do.
 */
export function useEndCall() {
  const invalidate = useInvalidateCallRecords();

  return useMutation({
    mutationFn: async (_vars: EndCallVars): Promise<void> => {
      invalidate();
    },
  });
}

export interface SaveSummaryVars {
  callId: string;
  summary: string;
}

/** Save the staff member's call summary — the only column staff may write. */
export function useSaveCallSummary() {
  const invalidate = useInvalidateCallRecords();

  return useMutation({
    mutationFn: async (vars: SaveSummaryVars): Promise<void> => {
      const { error } = await supabase.rpc('crm_save_call_summary', {
        p_session_id: vars.callId,
        p_summary: vars.summary,
      });
      if (error) throw error;
      invalidate();
    },
  });
}

/**
 * Which person the People table has selected for the summary-history panel.
 */
export function useCallCentreSelection() {
  const [selectedCalleeId, setSelectedCalleeId] = useState<string | null>(null);
  return { selectedCalleeId, setSelectedCalleeId };
}

/** Convenience: the roster's audience mix, for callers that need it pre-grouped. */
export function useRosterAudienceCounts() {
  const { rows } = useCallRoster();
  return useMemo(() => {
    const counts = new Map<CalleeRole, number>();
    for (const r of rows) counts.set(r.role, (counts.get(r.role) ?? 0) + 1);
    return counts;
  }, [rows]);
}
