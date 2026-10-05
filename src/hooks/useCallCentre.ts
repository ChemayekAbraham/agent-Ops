import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

/**
 * CRM Call Centre — calls placed through Africa's Talking Voice.
 *
 * Unlike the `tel:` links used elsewhere in the app, these calls are placed by
 * the server: AT rings the staff member's own phone first, then bridges the leg
 * to the customer. So `placeCall` succeeding means "your handset is about to
 * ring", not "the customer is connected" — the UI has to say so, or the flow
 * reads as broken.
 *
 * Telephony facts (status, duration, cost, recording) are written only by the
 * edge functions under the service role. Staff can annotate `disposition` and
 * `notes`, and nothing else — enforced by a column-level GRANT on the table.
 *
 * Call *outcomes* for tenants and landlords still belong in the existing
 * Calling Hubs (`tenant_call_reports` / `landlord_call_reports`). This hook
 * does not duplicate them.
 */

export type CallStatus =
  | 'initiating'
  | 'queued'
  | 'ringing_staff'
  | 'bridged'
  | 'completed'
  | 'no_answer'
  | 'failed';

export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
  initiating: 'Starting',
  queued: 'Ringing you',
  ringing_staff: 'You answered',
  bridged: 'Connecting',
  completed: 'Completed',
  no_answer: 'Not reached',
  failed: 'Failed',
};

/** Statuses that are still in flight, so the list should keep polling. */
const LIVE_STATUSES: CallStatus[] = ['initiating', 'queued', 'ringing_staff', 'bridged'];

export interface CallSession {
  id: string;
  at_session_id: string | null;
  staff_id: string;
  staff_phone: string;
  target_user_id: string | null;
  target_role: string | null;
  target_name: string | null;
  target_phone: string;
  status: CallStatus;
  hangup_cause: string | null;
  duration_seconds: number | null;
  recording_url: string | null;
  cost_amount: number | null;
  cost_currency: string | null;
  failure_reason: string | null;
  disposition: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SESSION_COLUMNS =
  'id, at_session_id, staff_id, staff_phone, target_user_id, target_role, target_name, ' +
  'target_phone, status, hangup_cause, duration_seconds, recording_url, cost_amount, ' +
  'cost_currency, failure_reason, disposition, notes, created_at, updated_at';

export interface CallSessionFilters {
  /** Only calls placed by the signed-in user. */
  mineOnly?: boolean;
  status?: CallStatus | 'all';
  limit?: number;
}

export function useCallSessions(filters: CallSessionFilters = {}) {
  const { mineOnly = false, status = 'all', limit = 100 } = filters;

  return useQuery({
    queryKey: ['crm-call-sessions', { mineOnly, status, limit }],
    queryFn: async () => {
      let q = (supabase as any)
        .from('crm_call_sessions')
        .select(SESSION_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (mineOnly) {
        const { data: auth } = await supabase.auth.getUser();
        if (!auth.user?.id) return [] as CallSession[];
        q = q.eq('staff_id', auth.user.id);
      }
      if (status !== 'all') q = q.eq('status', status);

      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as CallSession[];
    },
    staleTime: 10000,
    // A call in flight is updated by AT's callback, not by us — so poll while
    // anything is live, and go quiet once everything has settled.
    refetchInterval: (query) => {
      const rows = (query.state.data ?? []) as CallSession[];
      return rows.some((r) => LIVE_STATUSES.includes(r.status)) ? 4000 : false;
    },
  });
}

/** Full call history for one person, across every staff member who called them. */
export function useCallHistoryForUser(userId?: string | null) {
  return useQuery({
    queryKey: ['crm-call-history', userId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('crm_call_sessions')
        .select(SESSION_COLUMNS)
        .eq('target_user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as CallSession[];
    },
    enabled: !!userId,
    staleTime: 30000,
  });
}

export interface CallActivityRow {
  staff_id: string;
  call_day: string;
  calls_placed: number;
  calls_connected: number;
  calls_unreached: number;
  total_seconds: number;
  total_cost: number | null;
}

/** Today's rollup for the signed-in staff member. */
export function useMyCallActivityToday() {
  return useQuery({
    queryKey: ['crm-call-activity-today'],
    queryFn: async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return null;

      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const { data, error } = await (supabase as any)
        .from('v_crm_call_activity')
        .select('*')
        .eq('staff_id', uid)
        .gte('call_day', startOfDay.toISOString())
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as CallActivityRow | null;
    },
    staleTime: 30000,
  });
}

export interface PlaceCallInput {
  targetUserId?: string | null;
  /** Required when there is no `targetUserId` (free-typed number). */
  targetPhone?: string | null;
  targetName?: string | null;
  targetRole?: string | null;
  /** Take the call on a different handset than the profile phone. */
  staffPhone?: string | null;
}

export interface PlaceCallResult {
  ok: true;
  session_id: string;
  at_session_id: string | null;
  ringing: string;
  then_dialing: string;
  message: string;
}

export function usePlaceCall() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: PlaceCallInput) => {
      if (!input.targetUserId && !input.targetPhone?.trim()) {
        throw new Error('Pick a person to call, or type a phone number.');
      }

      const { data, error } = await supabase.functions.invoke('crm-place-call', {
        body: {
          target_user_id: input.targetUserId || null,
          target_phone: input.targetPhone?.trim() || null,
          target_name: input.targetName || null,
          target_role: input.targetRole || null,
          staff_phone: input.staffPhone?.trim() || null,
        },
      });

      // A non-2xx from an edge function surfaces as `error` with the useful
      // detail buried in the response body, so read the body first.
      if (error) {
        const detail =
          (data as any)?.error ||
          (await readFunctionError(error)) ||
          error.message;
        throw new Error(detail);
      }
      if ((data as any)?.error) throw new Error((data as any).error);

      return data as PlaceCallResult;
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['crm-call-sessions'] });
      qc.invalidateQueries({ queryKey: ['crm-call-activity-today'] });
      toast.success('Answer your phone', { description: res.message });
    },
    onError: (e: any) => {
      toast.error('Could not place the call', { description: e?.message });
    },
  });
}

/**
 * `FunctionsHttpError` keeps the JSON body on `context` (a Response). Without
 * this the user only ever sees "Edge Function returned a non-2xx status code",
 * which hides the actual reason (no voice number, invalid phone, …).
 */
async function readFunctionError(error: unknown): Promise<string | null> {
  const ctx = (error as any)?.context;
  if (!ctx || typeof ctx.json !== 'function') return null;
  try {
    const body = await ctx.json();
    return body?.error ?? null;
  } catch {
    return null;
  }
}

export function useAnnotateCall() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: { sessionId: string; disposition?: string | null; notes?: string | null }) => {
      const patch: Record<string, string | null> = {};
      if (input.disposition !== undefined) patch.disposition = input.disposition?.trim() || null;
      if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
      if (Object.keys(patch).length === 0) return;

      const { error } = await (supabase as any)
        .from('crm_call_sessions')
        .update(patch)
        .eq('id', input.sessionId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm-call-sessions'] });
      qc.invalidateQueries({ queryKey: ['crm-call-history'] });
      toast.success('Call notes saved');
    },
    onError: (e: any) => toast.error(e?.message || 'Could not save the notes'),
  });
}
