import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';

/**
 * Data hooks for the CRM view of the agent assistant: conversations, threads and escalations.
 * Logic only; screens are built on top of these.
 *
 * Read access is enforced by row-level security (crm, cto, manager, coo, ceo, super_admin).
 * The tables are written only by the agent-assistant edge function, so the one thing the CRM
 * can change is an escalation's status, assignee and notes. Who resolved it and when are
 * stamped by the database from the verified session, never sent from here.
 */

export type EscalationStatus = 'open' | 'in_progress' | 'resolved' | 'dismissed';
export type EscalationReason = 'user_requested' | 'unanswered' | 'out_of_scope_repeated' | 'wrong_answer';
export type AssistantOutcome =
  | 'answered'
  | 'clarify'
  | 'out_of_scope'
  | 'not_an_agent'
  | 'unmatched'
  | 'rate_limited'
  | 'blocked'
  | 'error';

/** Turns the assistant could not answer: what the CRM needs to follow up on. */
export const ASSISTANT_FAILURE_OUTCOMES: AssistantOutcome[] = ['unmatched', 'blocked', 'error', 'out_of_scope'];

export const ESCALATION_REASON_LABEL: Record<EscalationReason, string> = {
  user_requested: 'Agent asked for support',
  unanswered: 'Assistant could not answer',
  out_of_scope_repeated: 'Repeated out-of-scope questions',
  wrong_answer: 'Agent reported a wrong answer',
};

type ConversationRow = Tables<'assistant_conversations'>;
type MessageRow = Tables<'assistant_messages'>;
type EscalationRow = Tables<'assistant_escalations'>;

export interface AssistantPerson {
  id: string;
  full_name: string | null;
  phone: string | null;
}

/**
 * Context captured when the conversation started. IP, user agent and device_* are observed by
 * the server. `client_device` and the GPS fields are REPORTED BY THE AGENT'S DEVICE and can be
 * spoofed: label them as such in the UI and never treat them as proof of where someone was.
 */
export type AssistantConversationContext = Pick<
  ConversationRow,
  | 'ip_address'
  | 'user_agent'
  | 'device_class'
  | 'device_browser'
  | 'device_os'
  | 'client_device'
  | 'geo_lat'
  | 'geo_lng'
  | 'geo_accuracy_m'
  | 'geo_captured_at'
>;

export interface AssistantConversation extends ConversationRow {
  person: AssistantPerson;
  /** Assistant turns that ended in unmatched / blocked / error / out_of_scope. */
  failedTurns: number;
}

export interface AssistantEscalation extends EscalationRow {
  person: AssistantPerson;
  conversation: AssistantConversation | null;
}

const KEYS = {
  escalations: ['assistant-crm', 'escalations'] as const,
  conversations: ['assistant-crm', 'conversations'] as const,
  thread: ['assistant-crm', 'thread'] as const,
  openCount: ['assistant-crm', 'open-count'] as const,
};

async function loadPeople(ids: string[]): Promise<Record<string, AssistantPerson>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out: Record<string, AssistantPerson> = {};
  for (const id of unique) out[id] = { id, full_name: null, phone: null };
  if (!unique.length) return out;
  const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', unique);
  for (const p of data ?? []) out[p.id] = { id: p.id, full_name: p.full_name ?? null, phone: p.phone ?? null };
  return out;
}

async function loadFailedCounts(conversationIds: string[]): Promise<Record<string, number>> {
  if (!conversationIds.length) return {};
  const { data, error } = await supabase
    .from('assistant_messages')
    .select('conversation_id')
    .in('conversation_id', conversationIds)
    .eq('role', 'assistant')
    .in('outcome', ASSISTANT_FAILURE_OUTCOMES);
  if (error) throw error;
  const counts: Record<string, number> = {};
  for (const r of data ?? []) counts[r.conversation_id] = (counts[r.conversation_id] ?? 0) + 1;
  return counts;
}

async function toConversations(rows: ConversationRow[]): Promise<AssistantConversation[]> {
  const [people, failed] = await Promise.all([
    loadPeople(rows.map((r) => r.user_id)),
    loadFailedCounts(rows.map((r) => r.id)),
  ]);
  return rows.map((r) => ({ ...r, person: people[r.user_id], failedTurns: failed[r.id] ?? 0 }));
}

/** Escalations, newest first. Defaults to the ones that still need a person. */
export function useAssistantEscalations(status: EscalationStatus | 'all' = 'open') {
  return useQuery({
    queryKey: [...KEYS.escalations, status],
    refetchInterval: 30_000,
    queryFn: async (): Promise<AssistantEscalation[]> => {
      let q = supabase.from('assistant_escalations').select('*').order('created_at', { ascending: false }).limit(200);
      if (status !== 'all') q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      const rows = data ?? [];
      if (!rows.length) return [];

      const { data: convs, error: convErr } = await supabase
        .from('assistant_conversations')
        .select('*')
        .in('id', [...new Set(rows.map((r) => r.conversation_id))]);
      if (convErr) throw convErr;
      const conversations = await toConversations(convs ?? []);
      const byId = new Map(conversations.map((c) => [c.id, c]));
      const people = await loadPeople(rows.map((r) => r.user_id));

      return rows.map((r) => ({ ...r, person: people[r.user_id], conversation: byId.get(r.conversation_id) ?? null }));
    },
  });
}

/** Count of escalations waiting on a person, for a sidebar badge. */
export function useOpenAssistantEscalationCount() {
  return useQuery({
    queryKey: KEYS.openCount,
    refetchInterval: 60_000,
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from('assistant_escalations')
        .select('id', { count: 'exact', head: true })
        .in('status', ['open', 'in_progress']);
      if (error) throw error;
      return count ?? 0;
    },
  });
}

/** Recent conversations, most recently active first. */
export function useAssistantConversations(opts: { onlyWithFailures?: boolean; limit?: number } = {}) {
  const { onlyWithFailures = false, limit = 50 } = opts;
  return useQuery({
    queryKey: [...KEYS.conversations, onlyWithFailures, limit],
    refetchInterval: 60_000,
    queryFn: async (): Promise<AssistantConversation[]> => {
      const { data, error } = await supabase
        .from('assistant_conversations')
        .select('*')
        .order('last_active_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      const rows = await toConversations(data ?? []);
      return onlyWithFailures ? rows.filter((r) => r.failedTurns > 0) : rows;
    },
  });
}

/** One conversation's messages in order, with what the assistant did on each turn. */
export function useAssistantThread(conversationId: string | null) {
  return useQuery({
    queryKey: [...KEYS.thread, conversationId ?? ''],
    enabled: !!conversationId,
    queryFn: async (): Promise<Pick<MessageRow, 'id' | 'role' | 'content' | 'outcome' | 'tools_called' | 'model' | 'latency_ms' | 'created_at'>[]> => {
      const { data, error } = await supabase
        .from('assistant_messages')
        .select('id, role, content, outcome, tools_called, model, latency_ms, created_at')
        .eq('conversation_id', conversationId as string)
        .order('created_at', { ascending: true })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Work an escalation: change status, assign it, add resolution notes. Moving it to
 * resolved/dismissed stamps who and when in the database.
 */
export function useUpdateAssistantEscalation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      status?: EscalationStatus;
      assigned_to?: string | null;
      resolution_notes?: string | null;
    }) => {
      const { id, ...changes } = input;
      const patch: Record<string, unknown> = {};
      if (changes.status !== undefined) patch.status = changes.status;
      if (changes.assigned_to !== undefined) patch.assigned_to = changes.assigned_to;
      if (changes.resolution_notes !== undefined) patch.resolution_notes = changes.resolution_notes?.slice(0, 2000) ?? null;
      const { error } = await supabase.from('assistant_escalations').update(patch).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assistant-crm'] });
    },
  });
}
