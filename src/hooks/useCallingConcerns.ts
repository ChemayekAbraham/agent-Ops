/**
 * Received calls and forwarded concerns for the Calling Center.
 *
 * A deliberate sibling of the `cc_*` calling spine: nothing here reads or writes
 * the existing queue, attempts, feedback or follow-up records. Received calls are
 * calls that came IN and were typed up by hand; forwarded concerns are the
 * append-only hand-off trail that starts from either an outbound recorded call or
 * a received call.
 *
 * Every write goes through a SECURITY DEFINER function so the rules (who may
 * record, who may forward, who may move a concern along) live in one place.
 */
import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type ConcernStatus = 'sent' | 'received' | 'in_progress' | 'completed';
export type ConcernAction = 'accepted' | 'started' | 'progress_note' | 'completed';

/** Default answer time when nobody picks one. */
export const DEFAULT_CONCERN_DUE_HOURS = 24;
export type ReceivedCallStatus = 'open' | 'following_up' | 'resolved' | 'closed';

export const CONCERN_STATUS_LABEL: Record<ConcernStatus, string> = {
  sent: 'Sent',
  received: 'Received',
  in_progress: 'Being worked on',
  completed: 'Completed',
};

export const RECEIVED_STATUS_LABEL: Record<ReceivedCallStatus, string> = {
  open: 'Open',
  following_up: 'Following up',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const CONCERN_PRIORITY_LABEL: Record<string, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  critical: 'Critical',
};

export interface ReceivedCall {
  id: string;
  recorded_by: string;
  recorded_by_name: string | null;
  caller_name: string;
  caller_phone: string | null;
  linked_user_id: string | null;
  linked_kind: string | null;
  called_at: string;
  concern: string;
  notes: string | null;
  status: string;
  follow_up_at: string | null;
  follow_up_note: string | null;
  created_at: string;
}

export interface ForwardedConcern {
  id: string;
  source_kind: 'outbound_call' | 'received_call';
  feedback_id: string | null;
  received_call_id: string | null;
  cycle_row_id: string | null;
  caller_name: string | null;
  caller_user_id: string | null;
  subject_type: string | null;
  title: string;
  context: string | null;
  priority: string;
  forwarded_by: string;
  forwarded_by_name: string | null;
  forwarded_to: string;
  forwarded_to_name: string | null;
  status: string;
  due_at: string | null;
  accepted_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  outcome: string | null;
  follow_up_needed: boolean;
  follow_up_note: string | null;
  created_at: string;
  updated_at: string;
  original_forwarded_to: string | null;
  original_forwarded_to_name: string | null;
  reassigned_count: number;
  last_reassigned_at: string | null;
  last_reassigned_by: string | null;
  last_reassigned_by_name: string | null;
  due_is_custom: boolean;
  due_set_at: string | null;
  due_set_by: string | null;
  due_set_by_name: string | null;
}

export interface ConcernEvent {
  id: string;
  concern_id: string;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  note: string | null;
  status_after: string | null;
  created_at: string;
  prev_user_id: string | null;
  prev_user_name: string | null;
  new_user_id: string | null;
  new_user_name: string | null;
  prev_due_at: string | null;
  new_due_at: string | null;
  reason: string | null;
  prev_recipients: string | null;
  new_recipients: string | null;
}

export interface ConcernReviewer {
  concern_id: string;
  user_id: string;
  full_name: string | null;
  role: 'handler' | 'reviewer';
  added_by_name: string | null;
  created_at: string;
  added_reason: string | null;
  note: string | null;
  notified_at: string | null;
  acknowledged_at: string | null;
  removed_at: string | null;
  removed_by_name: string | null;
  remove_reason: string | null;
  active: boolean;
}

export interface ConcernPowers {
  can_reassign: boolean;
  can_set_due: boolean;
  is_hr: boolean;
  is_ceo: boolean;
  is_super_admin: boolean;
}

export interface StaffOption {
  user_id: string;
  staff_id: string | null;
  full_name: string;
}

const anyDb = supabase as any;

/** Staff who may receive a concern — live employee role, Platform Sales Officers excluded. */
export function useConcernStaffOptions() {
  return useQuery({
    queryKey: ['cc-forward-staff-options'],
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<StaffOption[]> => {
      const { data, error } = await anyDb.rpc('cc_forward_staff_options');
      if (error) throw new Error(error.message);
      return (data ?? []) as StaffOption[];
    },
  });
}

export function useReceivedCalls(days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return useQuery({
    queryKey: ['cc-received-calls', days],
    queryFn: async (): Promise<ReceivedCall[]> => {
      const { data, error } = await anyDb
        .from('cc_received_calls')
        .select('*')
        .gte('called_at', since)
        .order('called_at', { ascending: false })
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as ReceivedCall[];
    },
  });
}

export interface RecordReceivedCallInput {
  caller_name: string;
  concern: string;
  caller_phone?: string | null;
  linked_user_id?: string | null;
  linked_kind?: string | null;
  called_at?: string;
  status?: ReceivedCallStatus;
  follow_up_at?: string | null;
  follow_up_note?: string | null;
}

export function useRecordReceivedCall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordReceivedCallInput): Promise<string> => {
      const { data, error } = await anyDb.rpc('cc_record_received_call', {
        p_caller_name: input.caller_name,
        p_concern: input.concern,
        p_caller_phone: input.caller_phone ?? null,
        p_linked_user_id: input.linked_user_id ?? null,
        p_linked_kind: input.linked_kind ?? null,
        p_called_at: input.called_at ?? new Date().toISOString(),
        p_status: input.status ?? 'open',
        p_follow_up_at: input.follow_up_at ?? null,
        p_follow_up_note: input.follow_up_note ?? null,
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cc-received-calls'] });
    },
  });
}


export function useUpdateReceivedCall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      status?: ReceivedCallStatus;
      notes?: string | null;
      follow_up_at?: string | null;
      follow_up_note?: string | null;
    }) => {
      const { error } = await anyDb.rpc('cc_update_received_call', {
        p_id: input.id,
        p_status: input.status ?? null,
        p_notes: input.notes ?? null,
        p_follow_up_at: input.follow_up_at ?? null,
        p_follow_up_note: input.follow_up_note ?? null,
      });
      if (error) throw new Error(error.message);
      return true;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cc-received-calls'] });
    },
  });
}

/**
 * Forwarded concerns. Row-level rules decide the reach: the sender and the
 * receiver see their own, while HR, the CEO, the COO and Tenant Ops see all of
 * them for the reports.
 */
export function useForwardedConcerns(opts: { days?: number; scope?: 'all' | 'to_me' | 'from_me' } = {}) {
  const { days = 60, scope = 'all' } = opts;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return useQuery({
    queryKey: ['cc-forwarded-concerns', days, scope],
    queryFn: async (): Promise<ForwardedConcern[]> => {
      let q = anyDb
        .from('cc_forwarded_concerns')
        .select('*')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1000);
      if (scope !== 'all') {
        const { data: auth } = await supabase.auth.getUser();
        const uid = auth?.user?.id;
        if (!uid) return [];
        q = scope === 'to_me' ? q.eq('forwarded_to', uid) : q.eq('forwarded_by', uid);
      }
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as ForwardedConcern[];
    },
  });
}

/**
 * Every concern still open (status <> 'completed'), for any active staff
 * member — backs the "Open Concerns" browse/join tab in My Space. Eligibility
 * mirrors the same hr_my_staff_id() check that gates access to the Concerns
 * page itself, not the narrower cc_forward_staff_options() forwarding list.
 */
export function useOpenConcernsDirectory(enabled = true) {
  return useQuery({
    queryKey: ['cc-open-concerns-directory'],
    enabled,
    staleTime: 30 * 1000,
    queryFn: async (): Promise<ForwardedConcern[]> => {
      const { data, error } = await anyDb.rpc('cc_open_concerns_directory');
      if (error) throw new Error(error.message);
      return (data ?? []) as ForwardedConcern[];
    },
  });
}

/** Add the signed-in person to a concern they were not originally forwarded. */
export function useJoinConcern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { concern_id: string; note?: string | null }) => {
      const { data, error } = await anyDb.rpc('cc_join_concern', {
        p_concern_id: input.concern_id,
        p_note: input.note ?? null,
      });
      if (error) throw new Error(error.message);
      return data as { success: boolean; already_present: boolean; reviewer_name: string };
    },
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['cc-open-concerns-directory'] });
      void qc.invalidateQueries({ queryKey: ['cc-forwarded-concerns'] });
      void qc.invalidateQueries({ queryKey: ['cc-concern-reviewers'] });
      void qc.invalidateQueries({ queryKey: ['cc-concern-events', vars.concern_id] });
      void qc.invalidateQueries({ queryKey: ['cc-my-pending-concerns'] });
    },
  });
}

export function useConcernEvents(concernId: string | null) {
  return useQuery({
    queryKey: ['cc-concern-events', concernId],
    enabled: !!concernId,
    queryFn: async (): Promise<ConcernEvent[]> => {
      const { data, error } = await anyDb
        .from('cc_forwarded_concern_events')
        .select('*')
        .eq('concern_id', concernId)
        .order('created_at', { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as ConcernEvent[];
    },
  });
}

/** Everyone sharing one concern thread, including its original handler. */
export function useConcernReviewers(concernIds: string[]) {
  const key = [...concernIds].sort().join(',');
  return useQuery({
    queryKey: ['cc-concern-reviewers', key],
    enabled: concernIds.length > 0,
    queryFn: async (): Promise<ConcernReviewer[]> => {
      const { data, error } = await anyDb.rpc('cc_concern_reviewer_list', {
        p_concern_ids: concernIds,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as ConcernReviewer[];
    },
  });
}

/** Only the people currently on the concern. */
export const activeReviewers = (list: ConcernReviewer[]) => list.filter((r) => r.active);
/** People who were on it before and have since been taken off. */
export const pastReviewers = (list: ConcernReviewer[]) => list.filter((r) => !r.active);

export interface ForwardConcernInput {
  source_kind: 'outbound_call' | 'received_call';
  title: string;
  /** One or more staff members. The first opens the concern, the rest join it. */
  forwarded_to: string | string[];
  context?: string | null;
  priority?: string;
  feedback_id?: string | null;
  received_call_id?: string | null;
  cycle_row_id?: string | null;
  caller_name?: string | null;
  caller_user_id?: string | null;
  subject_type?: string | null;
  due_hours?: number;
}

export function useForwardConcern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ForwardConcernInput): Promise<string> => {
      const recipients = (Array.isArray(input.forwarded_to) ? input.forwarded_to : [input.forwarded_to]).filter(
        (id, i, arr) => !!id && arr.indexOf(id) === i,
      );
      if (recipients.length === 0) throw new Error('Choose at least one person.');

      const { data, error } = await anyDb.rpc('cc_forward_concern', {
        p_source_kind: input.source_kind,
        p_title: input.title,
        p_forwarded_to: recipients[0],
        p_context: input.context ?? null,
        p_priority: input.priority ?? 'normal',
        p_feedback_id: input.feedback_id ?? null,
        p_received_call_id: input.received_call_id ?? null,
        p_cycle_row_id: input.cycle_row_id ?? null,
        p_caller_name: input.caller_name ?? null,
        p_caller_user_id: input.caller_user_id ?? null,
        p_subject_type: input.subject_type ?? null,
        p_due_hours: input.due_hours ?? DEFAULT_CONCERN_DUE_HOURS,
      });
      if (error) throw new Error(error.message);
      if (typeof data !== 'string' || data.length === 0) {
        throw new Error('The concern was not saved. Please try again.');
      }
      const concernId = data as string;

      // Everyone else joins the same concern — one thread, never a duplicate.
      for (const userId of recipients.slice(1)) {
        const { error: addError } = await anyDb.rpc('cc_add_concern_reviewer', {
          p_concern_id: concernId,
          p_user_id: userId,
          p_note: input.context?.trim() || null,
        });
        if (addError) throw new Error(addError.message);
      }
      return concernId;
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['cc-forwarded-concerns'] }),
        qc.invalidateQueries({ queryKey: ['cc-received-calls'] }),
        qc.invalidateQueries({ queryKey: ['cc-concern-reviewers'] }),
      ]);
    },
  });
}

/** Add someone to a concern at any stage — sender, current people, HR or the CEO. */
export function useAddConcernReviewer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { concern_id: string; user_id: string; reason?: string | null }) => {
      const { data, error } = await anyDb.rpc('cc_add_concern_reviewer', {
        p_concern_id: input.concern_id,
        p_user_id: input.user_id,
        p_note: input.reason?.trim() || null,
      });
      if (error) throw new Error(error.message);
      return data as {
        success: boolean;
        already_present: boolean;
        reviewer_name: string;
        previous_recipients?: string | null;
        new_recipients?: string | null;
      };
    },
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['cc-concern-reviewers'] });
      void qc.invalidateQueries({ queryKey: ['cc-concern-events', vars.concern_id] });
      void qc.invalidateQueries({ queryKey: ['cc-forwarded-concerns'] });
    },
  });
}

/** Take someone off a concern. The record of their time on it is kept. */
export function useRemoveConcernReviewer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { concern_id: string; user_id: string; reason: string }) => {
      const { data, error } = await anyDb.rpc('cc_remove_concern_reviewer', {
        p_concern_id: input.concern_id,
        p_user_id: input.user_id,
        p_reason: input.reason,
      });
      if (error) throw new Error(error.message);
      return data as {
        success: boolean;
        removed_name: string;
        previous_recipients?: string | null;
        new_recipients?: string | null;
      };
    },
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['cc-concern-reviewers'] });
      void qc.invalidateQueries({ queryKey: ['cc-concern-events', vars.concern_id] });
      void qc.invalidateQueries({ queryKey: ['cc-forwarded-concerns'] });
    },
  });
}


export function useConcernEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      concern_id: string;
      action: ConcernAction;
      note?: string | null;
      follow_up_needed?: boolean | null;
      follow_up_note?: string | null;
    }) => {
      const { data, error } = await anyDb.rpc('cc_concern_event', {
        p_concern_id: input.concern_id,
        p_action: input.action,
        p_note: input.note ?? null,
        p_follow_up_needed: input.follow_up_needed ?? null,
        p_follow_up_note: input.follow_up_note ?? null,
      });
      if (error) throw new Error(error.message);
      return data as { success: boolean; status: ConcernStatus };
    },
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['cc-forwarded-concerns'] });
      void qc.invalidateQueries({ queryKey: ['cc-concern-events', vars.concern_id] });
    },
  });
}

/** Look a caller up among existing people, so a received call can be tied to them. */
export function useCallerLookup() {
  return useCallback(async (term: string) => {
    const q = term.trim();
    if (q.length < 3) return [] as { id: string; full_name: string | null; phone: string | null }[];
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, phone')
      .or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`)
      .limit(8);
    if (error) return [];
    return (data ?? []) as { id: string; full_name: string | null; phone: string | null }[];
  }, []);
}

export const isConcernOverdue = (c: ForwardedConcern) =>
  c.status !== 'completed' && !!c.due_at && new Date(c.due_at).getTime() < Date.now();

/** Whether the signed-in person may reassign a concern or change its answer time. */
export function useConcernPowers() {
  return useQuery({
    queryKey: ['cc-concern-powers'],
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ConcernPowers> => {
      const { data, error } = await anyDb.rpc('cc_concern_powers');
      if (error) throw new Error(error.message);
      return (data ?? {
        can_reassign: false,
        can_set_due: false,
        is_hr: false,
        is_ceo: false,
        is_super_admin: false,
      }) as ConcernPowers;
    },
  });
}

/** HR / CEO change who is handling a concern. The first recipient is kept forever. */
export function useReassignConcern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { concern_id: string; new_forwarded_to: string; reason: string }) => {
      const { data, error } = await anyDb.rpc('cc_reassign_concern', {
        p_concern_id: input.concern_id,
        p_new_forwarded_to: input.new_forwarded_to,
        p_reason: input.reason,
      });
      if (error) throw new Error(error.message);
      return data as { success: boolean; previous_recipient_name: string | null; new_recipient_name: string };
    },
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['cc-forwarded-concerns'] });
      void qc.invalidateQueries({ queryKey: ['cc-concern-events', vars.concern_id] });
    },
  });
}

/** The person handling it, HR or the CEO set or adjust the answer time. */
export function useSetConcernDue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { concern_id: string; due_at: string; reason: string }) => {
      const { data, error } = await anyDb.rpc('cc_set_concern_due', {
        p_concern_id: input.concern_id,
        p_due_at: input.due_at,
        p_reason: input.reason,
      });
      if (error) throw new Error(error.message);
      return data as { success: boolean; due_at: string; previous_due_at: string | null };
    },
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['cc-forwarded-concerns'] });
      void qc.invalidateQueries({ queryKey: ['cc-concern-events', vars.concern_id] });
    },
  });
}

/** Plain-language time left, or how long something has been past due. */
export function concernTimeLeft(c: ForwardedConcern): { label: string; overdue: boolean; hours: number | null } {
  if (!c.due_at) return { label: 'No answer time set', overdue: false, hours: null };
  const diffMs = new Date(c.due_at).getTime() - Date.now();
  const hours = diffMs / 3_600_000;
  if (c.status === 'completed') {
    return { label: 'Completed', overdue: false, hours };
  }
  const abs = Math.abs(diffMs);
  const d = Math.floor(abs / 86_400_000);
  const h = Math.floor((abs % 86_400_000) / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const span = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return diffMs < 0
    ? { label: `${span} past due`, overdue: true, hours }
    : { label: `${span} left`, overdue: false, hours };
}

/** How long a concern ran past its answer time, in hours (0 when it was on time). */
export function concernOverdueHours(c: ForwardedConcern): number {
  if (!c.due_at) return 0;
  const end = c.completed_at ? new Date(c.completed_at).getTime() : Date.now();
  const over = end - new Date(c.due_at).getTime();
  return over > 0 ? over / 3_600_000 : 0;
}

export const CONCERN_ACTION_LABEL: Record<string, string> = {
  forwarded: 'Forwarded',
  accepted: 'Confirmed received',
  started: 'Started working on it',
  progress_note: 'Progress note',
  completed: 'Completed',
  reassigned: 'Handler changed',
  due_changed: 'Answer time changed',
  reviewer_added: 'Person added',
  reviewer_removed: 'Person taken off',
};
