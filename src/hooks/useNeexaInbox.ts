import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export type NeexaPlatform = 'whatsapp' | 'email' | 'facebook' | 'instagram' | 'widget' | 'website' | 'portal';
export interface NeexaConversation {
  id: string; platform: NeexaPlatform; title: string | null; label: string | null;
  sentiment: string | null; customer_address: string | null; last_message_at: string | null;
  last_message_preview: string | null; last_inbound_at: string | null; updated_at: string | null;
}
export interface NeexaMessage {
  id: string; conversation_id: string; direction: 'inbound' | 'outbound';
  source: 'customer' | 'echo' | 'api' | 'sync'; creator_type: string | null;
  channel: string | null; body: string | null; status: string | null; sent_by: string | null;
  template_public_id: string | null; sent_at: string | null;
}
export interface NeexaTemplate {
  id: string; attributes: { name: string; public_id: string; header?: { text?: string };
    body?: { text?: string }; footer?: string | { text?: string } };
}
interface NeexaResponse {
  data?: { id?: string; attributes?: { ai_human_conversation_id?: string | number } } | NeexaTemplate[];
  meta?: { last_page?: number }; synced?: number; pages?: number; complete?: boolean;
  error?: string; message?: string; term?: string;
}

export const NEEXA_MESSAGE_LIMIT = 4096;
export function whatsappWindowClosed(conversation: Pick<NeexaConversation, 'platform' | 'last_inbound_at'>, now = Date.now()) {
  if (conversation.platform !== 'whatsapp') return false;
  const time = conversation.last_inbound_at ? Date.parse(conversation.last_inbound_at) : NaN;
  return !Number.isFinite(time) || now - time >= 24 * 60 * 60 * 1000;
}
export function canSendNeexaReply(message: string, conversation: Pick<NeexaConversation, 'platform' | 'last_inbound_at'>, now = Date.now()) {
  return message.trim().length > 0 && message.length <= NEEXA_MESSAGE_LIMIT && !whatsappWindowClosed(conversation, now);
}
export function neexaPlaceholderNumbers(text = ''): number[] {
  return [...new Set(Array.from(text.matchAll(/\{\{\s*(\d+)\s*\}\}/g), match => Number(match[1])))].sort((a, b) => a - b);
}
export function fillNeexaTemplate(text = '', values: Record<number, string>) {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (placeholder, index) => values[Number(index)] || placeholder);
}
export function normalizeNeexaPhone(phone: string): string | null {
  const compact = phone.replace(/[\s()-]/g, '');
  if (/^0[37]\d{8}$/.test(compact)) return `+256${compact.slice(1)}`;
  if (/^256[37]\d{8}$/.test(compact)) return `+${compact}`;
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}
export function neexaErrorMessage(payload: { error?: string; message?: string; term?: string }, status?: number) {
  if (status === 403 || payload.error === 'not_authorized') return "You don't have access to the inbox.";
  if (status === 502) return "Neexa couldn't deliver this right now.";
  if (payload.error === 'banned_term') return `Use 'Rent Plan', 'Supporter' and 'Returns' — '${payload.term || 'This term'}' isn't allowed in customer messages.`;
  if (payload.error === 'neexa_error') return payload.message || "Neexa couldn't deliver this right now.";
  return payload.message || 'Could not complete this request. Please try again.';
}
export function mergeNeexaRows<T extends { id: string }>(rows: T[], incoming: T[]): T[] {
  const map = new Map(rows.map(row => [row.id, row]));
  incoming.forEach(row => map.set(row.id, { ...map.get(row.id), ...row }));
  return [...map.values()];
}
export const sortNeexaConversations = (rows: NeexaConversation[]) => [...rows].sort((a, b) =>
  (b.last_message_at ? Date.parse(b.last_message_at) : -Infinity) - (a.last_message_at ? Date.parse(a.last_message_at) : -Infinity) || a.id.localeCompare(b.id));
const sortMessages = (rows: NeexaMessage[]) => [...rows].sort((a, b) =>
  (a.sent_at ? Date.parse(a.sent_at) : 0) - (b.sent_at ? Date.parse(b.sent_at) : 0) || a.id.localeCompare(b.id));

async function callNeexa(body: Record<string, unknown>): Promise<NeexaResponse> {
  const { data, error } = await supabase.functions.invoke('neexa-api', { body });
  if (error) {
    const response = error.context instanceof Response ? error.context : undefined;
    let payload: NeexaResponse = {};
    try { if (response) payload = await response.clone().json(); } catch { /* non-JSON service error */ }
    throw new Error(neexaErrorMessage(payload, response?.status));
  }
  if (data?.error) throw new Error(neexaErrorMessage(data));
  return data as NeexaResponse;
}
// Mirror tables intentionally use local interfaces: generated schema types are protected.
async function readConversations(): Promise<NeexaConversation[]> {
  const rows: NeexaConversation[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.from('neexa_conversations' as any).select('*')
      .order('last_message_at', { ascending: false, nullsFirst: false }).order('id').range(offset, offset + 499);
    if (error) throw new Error(neexaErrorMessage({ message: error.code === '42501' ? "You don't have access to the inbox." : error.message }));
    const page = (data ?? []) as unknown as NeexaConversation[];
    rows.push(...page);
    if (page.length < 500) return rows;
    offset += 500;
  }
}
async function readMessages(id: string): Promise<NeexaMessage[]> {
  const rows: NeexaMessage[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.from('neexa_messages' as any).select('*').eq('conversation_id', id)
      .order('sent_at', { ascending: true }).order('id').range(offset, offset + 499);
    if (error) throw new Error(error.code === '42501' ? "You don't have access to the inbox." : error.message);
    const page = (data ?? []) as unknown as NeexaMessage[];
    rows.push(...page);
    if (page.length < 500) return rows;
    offset += 500;
  }
}

export function useNeexaInbox() {
  const { user } = useAuth();
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(0);
  const [lastPage, setLastPage] = useState(1);
  const [templates, setTemplates] = useState<NeexaTemplate[]>([]);
  const [templatesBusy, setTemplatesBusy] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateSending, setTemplateSending] = useState(false);
  const [pendingConversation, setPendingConversation] = useState<{ id?: string; phone: string } | null>(null);
  const automaticSync = useRef(false);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const mounted = useRef(true);
  const syncLock = useRef(false);
  const sendLock = useRef(false);
  const templateLock = useRef(false);
  const listKey = ['neexa-conversations', user?.id] as const;
  const messageKey = (id: string) => ['neexa-messages', user?.id, id] as const;
  const conversationsQuery = useQuery({ queryKey: listKey, queryFn: readConversations, enabled: !!user,
    staleTime: Infinity, retry: false, refetchOnWindowFocus: false });
  const messagesQuery = useQuery({ queryKey: messageKey(selectedId || ''),
    queryFn: () => selectedId ? readMessages(selectedId) : Promise.resolve([]), enabled: !!user && !!selectedId,
    staleTime: Infinity, retry: false, refetchOnWindowFocus: false });

  useEffect(() => {
    mounted.current = true;
    if (!user) return;
    const channel = supabase.channel(`neexa-inbox:${user.id}`);
    const mergeConversation = (payload: { new: unknown }) => {
        const row = payload.new as NeexaConversation;
        client.setQueryData<NeexaConversation[]>(['neexa-conversations', user.id], old => sortNeexaConversations(mergeNeexaRows(old || [], [row])));
    };
    const mergeMessage = (payload: { new: unknown }) => {
        const row = payload.new as NeexaMessage;
        const key = ['neexa-messages', user.id, row.conversation_id];
        // Cache only threads already opened, avoiding a growing cache for every customer.
        if (client.getQueryState(key)) client.setQueryData<NeexaMessage[]>(key, old => sortMessages(mergeNeexaRows(old || [], [row])));
    };
    channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'neexa_conversations' }, mergeConversation)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'neexa_conversations' }, mergeConversation)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'neexa_messages' }, mergeMessage)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'neexa_messages' }, mergeMessage);
    channel.subscribe(status => {
      if (status === 'SUBSCRIBED') {
        void client.invalidateQueries({ queryKey: ['neexa-conversations', user.id] });
        if (selectedRef.current) void client.invalidateQueries({ queryKey: ['neexa-messages', user.id, selectedRef.current] });
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setActionError('Live connection interrupted. Sync from Neexa to refresh.');
    });
    return () => { mounted.current = false; void supabase.removeChannel(channel); };
  }, [user?.id, client]);

  const syncConversations = async () => {
    if (syncLock.current) return;
    syncLock.current = true; setSyncing(true); setActionError(null);
    try {
      const result = await callNeexa({ action: 'sync_conversations', max_pages: 20 });
      await conversationsQuery.refetch({ throwOnError: true });
      if (mounted.current) setSyncResult(`${result.synced ?? 0} conversations synced${result.complete ? '' : ' · Neexa has additional conversations beyond this sync limit'}`);
    } catch (error) { if (mounted.current) setActionError(error instanceof Error ? error.message : 'Sync failed.'); }
    finally { syncLock.current = false; if (mounted.current) setSyncing(false); }
  };
  useEffect(() => {
    if (conversationsQuery.isSuccess && conversationsQuery.data.length === 0 && !automaticSync.current) {
      automaticSync.current = true;
      void syncConversations();
    }
  }, [conversationsQuery.isSuccess, conversationsQuery.data]);

  const loadHistory = useCallback(async (id: string, page: number) => {
    setHistoryBusy(true); setHistoryError(null);
    try {
      const response = await callNeexa({ action: 'get_messages', conversation_id: id, page });
      const rows = await readMessages(id);
      client.setQueryData<NeexaMessage[]>(['neexa-messages', user?.id, id], old => sortMessages(mergeNeexaRows(old || [], rows)));
      if (mounted.current && selectedRef.current === id) {
        setHistoryPage(page); setLastPage(response.meta?.last_page ?? page);
      }
    } catch (error) {
      if (mounted.current && selectedRef.current === id) setHistoryError(error instanceof Error ? error.message : 'Could not load messages.');
    } finally { if (mounted.current && selectedRef.current === id) setHistoryBusy(false); }
  }, [client, user?.id]);
  useEffect(() => {
    setHistoryPage(0); setLastPage(1); setHistoryError(null); setActionError(null);
    if (selectedId) void loadHistory(selectedId, 1);
    else setHistoryBusy(false);
  }, [selectedId, loadHistory]);
  useEffect(() => {
    if (!pendingConversation) return;
    const found = conversationsQuery.data?.find(row => pendingConversation.id ? row.id === pendingConversation.id :
      row.platform === 'whatsapp' && normalizeNeexaPhone(row.customer_address || '') === pendingConversation.phone);
    if (found) { setSelectedId(found.id); setPendingConversation(null); }
  }, [pendingConversation, conversationsQuery.data]);

  const selected = conversationsQuery.data?.find(row => row.id === selectedId) || null;
  const sendMessage = async (message: string) => {
    if (!selected || !canSendNeexaReply(message, selected) || sendLock.current) return false;
    const id = selected.id;
    sendLock.current = true; setSending(true); setActionError(null);
    try {
      await callNeexa({ action: 'send_message', conversation_id: id, message });
      // Delivery succeeded; a read failure must not encourage a duplicate send.
      void client.invalidateQueries({ queryKey: messageKey(id) });
      void client.invalidateQueries({ queryKey: listKey });
      return true;
    } catch (error) { if (mounted.current) setActionError(error instanceof Error ? error.message : 'Could not send message.'); return false; }
    finally { sendLock.current = false; if (mounted.current) setSending(false); }
  };
  const loadTemplates = async () => {
    setTemplatesBusy(true); setTemplateError(null);
    try {
      const collected: NeexaTemplate[] = [];
      let page = 1;
      while (true) {
        const result = await callNeexa({ action: 'list_templates', page });
        if (Array.isArray(result.data)) collected.push(...result.data);
        if (page >= (result.meta?.last_page ?? page)) break;
        page++;
      }
      if (mounted.current) setTemplates(collected);
    } catch (error) { if (mounted.current) setTemplateError(error instanceof Error ? error.message : 'Could not load templates.'); }
    finally { if (mounted.current) setTemplatesBusy(false); }
  };
  const sendTemplate = async (template: string, phone: string, variables: { header?: string[]; body?: string[] }) => {
    const to = normalizeNeexaPhone(phone);
    if (!to || templateLock.current) return false;
    templateLock.current = true; setTemplateSending(true); setTemplateError(null);
    try {
      const response = await callNeexa({ action: 'send_template', template, to, variables });
      const resource = Array.isArray(response.data) ? undefined : response.data;
      const id = resource?.attributes?.ai_human_conversation_id;
      if (mounted.current) setPendingConversation({ id: id != null ? String(id) : undefined, phone: to });
      void client.invalidateQueries({ queryKey: listKey });
      return true;
    } catch (error) { if (mounted.current) setTemplateError(error instanceof Error ? error.message : 'Could not send template.'); return false; }
    finally { templateLock.current = false; if (mounted.current) setTemplateSending(false); }
  };
  return { conversations: conversationsQuery.data || [], loading: conversationsQuery.isLoading,
    listError: conversationsQuery.error?.message, selected, selectedId, openConversation: setSelectedId,
    messages: messagesQuery.data || [], messagesLoading: messagesQuery.isLoading, messagesError: messagesQuery.error?.message,
    actionError, syncing, syncResult, syncConversations, sending, sendMessage,
    historyBusy, historyError, hasEarlier: historyPage < lastPage,
    loadEarlier: () => selectedId ? loadHistory(selectedId, historyPage + 1) : Promise.resolve(),
    templates, templatesBusy, templateError, templateSending, loadTemplates, sendTemplate, pendingConversation };
}
