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
  CALL_SECTIONS,
  buildOutcomeTrend,
  computeSectionKpis,
  deriveOutcome,
  type CalleeRole,
  type CallOutcome,
  type CallRecord,
  type CallSection,
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

/* ------------------------------------------------------------------ *
 * Platform people — every user, with every role they actually hold
 * ------------------------------------------------------------------ */

/** One person on the platform-wide people directory. */
export interface PlatformPerson {
  calleeId: string;
  name: string;
  phone: string;
  hasPhone: boolean;
  avatarUrl: string | null;
  location: string | null;
  /** Every audience this person genuinely belongs to. Can be empty. */
  roles: CalleeRole[];
  status: CallOutcome | null;
  calledAt: string | null;
  recalledAt: string | null;
  totalCalls: number;
  summaries: number;
  lastCallId: string | null;
}

export type PeopleStatusFilter = CallOutcome | 'all' | 'never';
export type PeopleSort = 'name' | 'recent_call' | 'newest';

export interface PlatformPeopleQuery {
  search?: string;
  /**
   * A raw role ('agent', 'landlord', …) or a Call Centre queue
   * ('operational_agent', 'proxy_agent'). `crm_platform_people_page` tests
   * membership against `v_crm_person_roles` first and `v_crm_call_section`
   * second, so both kinds of value resolve.
   */
  role?: CalleeRole | CallSection | 'all';
  /**
   * Narrows WITHIN a queue: 'agent' / 'sub_agent' for operational_agent, or a
   * tenant lifecycle stage. Null or omitted means the whole queue. Only
   * meaningful when `role` is a queue name.
   */
  subtype?: string | null;
  status?: PeopleStatusFilter;
  sort?: PeopleSort;
  page?: number;
  pageSize?: number;
}

interface PlatformPersonRow {
  person_id: string;
  name: string | null;
  phone_masked: string | null;
  has_phone: boolean | null;
  location: string | null;
  avatar_url: string | null;
  roles: string[] | null;
  total_calls: number | null;
  summaries: number | null;
  first_called_at: string | null;
  last_called_at: string | null;
  last_outcome: string | null;
  last_call_id: string | null;
  total_rows: number | null;
}

export const PEOPLE_PAGE_SIZE = 20;

/**
 * Server-paged directory of EVERY platform user.
 *
 * Filtering, searching, sorting and counting all happen in SQL — 61k+ profiles
 * are never shipped to the browser. Roles come from real evidence (rent
 * records, portfolios, landlord float disbursements, agent links, staff roles),
 * so a person can hold several at once.
 */
export function usePlatformPeople(params: PlatformPeopleQuery = {}) {
  const {
    search = '',
    role = 'all',
    subtype = null,
    status = 'all',
    sort = 'name',
    page = 0,
    pageSize = PEOPLE_PAGE_SIZE,
  } = params;

  const query = useQuery({
    // `subtype` belongs in the key: without it, switching the in-queue filter
    // would serve the previous filter's cached page.
    queryKey: ['crm-platform-people', search, role, subtype, status, sort, page, pageSize],
    queryFn: async (): Promise<{ rows: PlatformPerson[]; total: number }> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('crm_platform_people_page', {
        p_search: search.trim() || null,
        p_role: role === 'all' ? null : role,
        p_subtype: subtype ?? null,
        p_status: status === 'all' ? null : status,
        p_sort: sort,
        p_limit: pageSize,
        p_offset: page * pageSize,
      });
      if (error) throw error;

      const raw = (data ?? []) as PlatformPersonRow[];
      return {
        total: Number(raw[0]?.total_rows ?? 0),
        rows: raw.map((r) => ({
          calleeId: r.person_id,
          name: r.name?.trim() || 'Unnamed user',
          phone: r.phone_masked ?? '—',
          hasPhone: r.has_phone === true,
          avatarUrl: r.avatar_url,
          location: r.location,
          roles: (r.roles ?? []).filter((x): x is CalleeRole => CALLEE_ROLES.includes(x as CalleeRole)),
          status: r.last_call_id ? ((r.last_outcome ?? 'not_reachable') as CallOutcome) : null,
          calledAt: r.first_called_at,
          recalledAt: r.last_called_at,
          totalCalls: Number(r.total_calls ?? 0),
          summaries: Number(r.summaries ?? 0),
          lastCallId: r.last_call_id,
        })),
      };
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  return {
    rows: query.data?.rows ?? [],
    total: query.data?.total ?? 0,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
  };
}

/** Platform-wide audience sizes, for the filter chips. */
export function usePlatformPeopleCounts() {
  const query = useQuery({
    queryKey: ['crm-platform-people-counts'],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('crm_platform_people_counts');
      if (error) throw error;
      const row = (data ?? [])[0] as Record<string, number> | undefined;
      return {
        all: Number(row?.all_users ?? 0),
        tenant: Number(row?.tenants ?? 0),
        agent: Number(row?.agents ?? 0),
        sub_agent: Number(row?.sub_agents ?? 0),
        partner: Number(row?.partners ?? 0),
        landlord: Number(row?.landlords ?? 0),
        employee: Number(row?.employees ?? 0),
      };
    },
    staleTime: 300_000,
  });
  return query.data ?? null;
}

function useInvalidateCallRecords() {
  const qc = useQueryClient();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: CALL_RECORDS_KEY });
    qc.invalidateQueries({ queryKey: CALL_ROSTER_KEY });
  }, [qc]);
}

/**
 * Refresh every view that shows a call or a caller.
 *
 * `useInvalidateCallRecords` covers only the two flat keys that existed before
 * the Call Centre was split into queues. Everything a user actually looks at
 * now - the per-queue overview, people table, call log and summaries - is keyed
 * separately, so a finished call left them all stale and the only way to see
 * the outcome was to reload the page.
 *
 * Deliberately broad. These are cheap reads over a few hundred rows, and a
 * missed key is a call that still reads as in progress.
 */
export function useInvalidateCallViews() {
  const qc = useQueryClient();
  return useCallback(() => {
    [
      CALL_RECORDS_KEY,
      CALL_ROSTER_KEY,
      ['crm-section-records'],
      ['crm-section-summaries'],
      ['crm-section-roster'],
      ['crm-platform-people'],
      ['crm-call-section-counts'],
      ['crm-platform-people-counts'],
    ].forEach((key) => qc.invalidateQueries({ queryKey: key as readonly unknown[] }));
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

      // A non-2xx reply carries the operator-readable reason in its body (e.g.
      // "Voice calling is out of credit"). Without this it is swallowed as a
      // generic "Edge Function returned a non-2xx status code".
      if (error) {
        const ctx = (error as { context?: Response }).context;
        if (ctx && typeof ctx.json === 'function') {
          const body = await ctx.json().catch(() => null) as { message?: string; error?: string } | null;
          if (body?.message || body?.error) throw new Error(body.message ?? body.error!);
        }
        throw error;
      }

      const payload = data as { callId?: string; error?: string; message?: string } | null;
      if (!payload?.callId) throw new Error(payload?.message ?? payload?.error ?? 'could_not_place_call');

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
 * Manual failure override — the write path behind "They rejected" / "Not
 * reachable".
 *
 * The staff member can see what the provider cannot: the customer picked up and
 * refused, or the number is plainly wrong. This still does not write telephony
 * state from the client — it goes through the `crm_record_call_outcome` RPC,
 * which is role-gated and applies ONLY while the row is still live, so a
 * terminal callback that already landed is never overwritten by a human
 * assertion.
 *
 * 'answered' is intentionally not sent: talk time is the provider's to report,
 * and letting staff assert it would corrupt both the answer rate and the
 * average-talk-time figure.
 */
/**
 * Cancel / hang up a live call for real.
 *
 * `crm-hangup-call` does both halves: it flags the row via `crm_cancel_call`
 * (authoritative — the voice callback then answers with <Hangup/> and never
 * bridges) and asks Africa's Talking to drop the leg immediately. The provider
 * drop only works while AT still controls the leg, so `providerDropped` tells
 * the UI whether the handset stopped ringing now or will stop on the next
 * provider event.
 *
 * Falls back to the RPC alone if the function is unreachable, so the red button
 * never becomes a no-op.
 */
export function useCancelCall() {
  const invalidate = useInvalidateCallRecords();

  return useMutation({
    mutationFn: async (callId: string): Promise<{ providerDropped: boolean }> => {
      try {
        const { data, error } = await supabase.functions.invoke('crm-hangup-call', {
          body: { callId },
        });
        if (error) throw error;
        invalidate();
        return { providerDropped: Boolean((data as { providerDropped?: boolean } | null)?.providerDropped) };
      } catch (fnErr) {
        console.warn('[useCancelCall] hangup function failed, falling back to RPC', fnErr);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any).rpc('crm_cancel_call', { p_session_id: callId });
        if (error) throw error;
        invalidate();
        return { providerDropped: false };
      }
    },
  });
}

export function useEndCall() {
  const invalidate = useInvalidateCallRecords();

  return useMutation({
    mutationFn: async (vars: EndCallVars): Promise<void> => {
      if (vars.outcome === 'rejected' || vars.outcome === 'not_reachable') {
        // Cross-runtime escape hatch (project convention): this RPC is newer
        // than the generated types. Drop the cast once
        // src/integrations/supabase/types.ts is regenerated.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any).rpc('crm_record_call_outcome', {
          p_session_id: vars.callId,
          p_outcome: vars.outcome,
        });
        if (error) throw error;
      }
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

/* ------------------------------------------------------------------
 * Per-queue reads
 *
 * The Call Centre is five queues (see `v_crm_call_section`), each showing the
 * same four views. Everything below takes a `CallSection` and is otherwise the
 * same query the flat Call Centre already ran, so the shared components need
 * one extra prop rather than a fork per audience.
 *
 * Queue membership is resolved SERVER-side on every read. Filtering client-side
 * on `record.calleeRole` would be wrong twice over: the roster is paged, so the
 * client never holds the whole queue, and `crm_call_sessions.target_role` is a
 * snapshot written when the call was placed - it still says 'agent' for someone
 * who became a proxy agent afterwards.
 * ------------------------------------------------------------------ */

/** How many people sit in each queue. Feeds the "Total Numbers" tile. */
export function useCallSectionCounts() {
  const query = useQuery({
    queryKey: ['crm-call-section-counts'],
    queryFn: async (): Promise<Record<CallSection, number>> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await supabase.rpc('crm_call_section_counts' as any);
      if (error) throw error;
      const out = {} as Record<CallSection, number>;
      for (const section of CALL_SECTIONS) out[section] = 0;
      for (const row of (data ?? []) as { section: string; people: number }[]) {
        if ((CALL_SECTIONS as string[]).includes(row.section)) {
          out[row.section as CallSection] = Number(row.people ?? 0);
        }
      }
      return out;
    },
    staleTime: 5 * 60_000,
  });
  return { ...query, counts: query.data ?? ({} as Record<CallSection, number>) };
}

/** Every call placed to one queue in the window. Powers Overview and Call Logs. */
export function useSectionCallRecords(section: CallSection | null, days = 30) {
  const query = useQuery({
    queryKey: ['crm-section-records', section, days],
    enabled: Boolean(section),
    queryFn: async (): Promise<CallRecord[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await supabase.rpc('crm_call_sessions_feed' as any, {
        p_days: days,
        p_limit: 2000,
        p_target_user_id: null,
        p_section: section,
      });
      if (error) throw error;
      return ((data ?? []) as FeedRow[]).map(toCallRecord);
    },
    staleTime: 30_000,
  });
  return { ...query, records: query.data ?? [] };
}

/**
 * Only the calls staff actually wrote up. The Summaries tab is a record of what
 * was said, so a call with no note has nothing to show and is excluded at the
 * database rather than filtered out after fetching 2,000 rows.
 */
export function useSectionSummaries(section: CallSection | null, days = 90) {
  const query = useQuery({
    queryKey: ['crm-section-summaries', section, days],
    enabled: Boolean(section),
    queryFn: async (): Promise<CallRecord[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await supabase.rpc('crm_call_sessions_feed' as any, {
        p_days: days,
        p_limit: 2000,
        p_target_user_id: null,
        p_section: section,
        p_with_summary_only: true,
      });
      if (error) throw error;
      return ((data ?? []) as FeedRow[]).map(toCallRecord);
    },
    staleTime: 30_000,
  });
  return { ...query, summaries: query.data ?? [] };
}

/** One page of a queue's people, searchable by name or number. */
export function useSectionRoster(
  section: CallSection | null,
  options: { search?: string; page?: number; pageSize?: number } = {},
) {
  const search = (options.search ?? '').trim();
  const page = options.page ?? 0;
  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 200);

  const query = useQuery({
    queryKey: ['crm-section-roster', section, search, page, pageSize],
    enabled: Boolean(section),
    queryFn: async (): Promise<{ rows: RosterPerson[]; total: number }> => {
      const { data, error } = await supabase.rpc('crm_call_roster_page', {
        p_search: search || null,
        p_role: section,
        p_limit: pageSize,
        p_offset: page * pageSize,
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
          status: r.last_call_id
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

  return {
    ...query,
    rows: query.data?.rows ?? [],
    total: query.data?.total ?? 0,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil((query.data?.total ?? 0) / pageSize)),
  };
}

/** The nine KPI tiles for one queue, ready to render. */
export function useSectionKpis(section: CallSection | null, days = 30) {
  const { records, isLoading: recordsLoading } = useSectionCallRecords(section, days);
  const { counts, isLoading: countsLoading } = useCallSectionCounts();

  const kpis = useMemo(
    () => computeSectionKpis(records, section ? (counts[section] ?? 0) : 0),
    [records, counts, section],
  );
  const trend = useMemo(() => buildOutcomeTrend(records, { days }), [records, days]);

  return { kpis, trend, records, isLoading: recordsLoading || countsLoading };
}
