import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), invoke: vi.fn(), channel: vi.fn(), removeChannel: vi.fn(), handlers: [] as { filter: { event: string; table: string }; callback: (payload: { new: unknown }) => void }[] }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { ...mocks, functions: { invoke: mocks.invoke } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'staff' } }) }));
import { useNeexaInbox } from '@/hooks/useNeexaInbox';
let conversations: unknown[];
let messages: unknown[];
const conversation = { id: '10', platform: 'email', title: 'Customer', last_inbound_at: null, last_message_at: '2026-10-21T07:00:00Z' };
const message = { id: '1', conversation_id: '10', body: 'Hello', direction: 'inbound', source: 'customer', sent_at: '2026-10-21T07:00:00Z' };
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, Wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.length = 0;
  conversations = [conversation]; messages = [message];
  mocks.from.mockImplementation(table => {
    const result = () => ({ data: table === 'neexa_conversations' ? conversations : messages, error: null });
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), range: vi.fn(() => Promise.resolve(result())) };
    return query;
  });
  mocks.invoke.mockImplementation(async (_name, { body }) => ({ data: body.action === 'get_messages' ? { meta: { last_page: 3 } } : { synced: 1, pages: 1, complete: true }, error: null }));
  mocks.channel.mockImplementation(() => {
    const channel = { on: vi.fn((_type, filter, callback) => { mocks.handlers.push({ filter, callback }); return channel; }), subscribe: vi.fn().mockReturnThis() };
    return channel;
  });
});
describe('Neexa Inbox hook', () => {
  it('subscribes to inserts and updates on both mirrors and cleans up on unmount', async () => {
    const { Wrapper } = wrapper();
    const { result, unmount } = renderHook(() => useNeexaInbox(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));
    expect(mocks.handlers.map(row => `${row.filter.table}:${row.filter.event}`)).toEqual(['neexa_conversations:INSERT', 'neexa_conversations:UPDATE', 'neexa_messages:INSERT', 'neexa_messages:UPDATE']);
    act(() => mocks.handlers[1].callback({ new: { ...conversation, title: 'Updated customer' } }));
    await waitFor(() => expect(result.current.conversations[0].title).toBe('Updated customer'));
    unmount(); expect(mocks.removeChannel).toHaveBeenCalledTimes(1);
  });
  it('opens full history, loads next pages and merges live outbound status', async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useNeexaInbox(), { wrapper: Wrapper });
    act(() => result.current.openConversation('10'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await waitFor(() => expect(result.current.historyBusy).toBe(false));
    expect(mocks.invoke).toHaveBeenCalledWith('neexa-api', { body: { action: 'get_messages', conversation_id: '10', page: 1 } });
    await act(async () => { await result.current.loadEarlier(); });
    expect(mocks.invoke).toHaveBeenCalledWith('neexa-api', { body: { action: 'get_messages', conversation_id: '10', page: 2 } });
    expect(result.current.hasEarlier).toBe(true);
    await act(async () => { await result.current.loadEarlier(); });
    expect(result.current.hasEarlier).toBe(false);
    act(() => mocks.handlers[2].callback({ new: { ...message, id: '2', direction: 'outbound', status: 'pending' } }));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    act(() => mocks.handlers[3].callback({ new: { ...message, id: '2', direction: 'outbound', status: 'read' } }));
    await waitFor(() => expect(result.current.messages[1].status).toBe('read'));
    expect(result.current.messages).toHaveLength(2);
  });
  it('syncs once automatically only for an empty mirror', async () => {
    conversations = [];
    const { Wrapper } = wrapper();
    const { result, rerender } = renderHook(() => useNeexaInbox(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.syncResult).toContain('1 conversations synced'));
    rerender();
    expect(mocks.invoke.mock.calls.filter(([, options]) => options.body.action === 'sync_conversations')).toHaveLength(1);
  });
  it('sends through the existing API and selects the new template conversation', async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useNeexaInbox(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.conversations).toHaveLength(1));
    act(() => result.current.openConversation('10'));
    await waitFor(() => expect(result.current.selected?.id).toBe('10'));
    await act(async () => { expect(await result.current.sendMessage('Hello')).toBe(true); });
    expect(mocks.invoke).toHaveBeenCalledWith('neexa-api', { body: { action: 'send_message', conversation_id: '10', message: 'Hello' } });
    conversations = [...conversations, { ...conversation, id: '20', platform: 'whatsapp', customer_address: '+256772123456' }];
    mocks.invoke.mockResolvedValueOnce({ data: { data: { id: '99', attributes: { ai_human_conversation_id: '20' } } }, error: null });
    await act(async () => { expect(await result.current.sendTemplate('approved', '0772123456', { body: ['Sarah'] })).toBe(true); });
    await waitFor(() => expect(result.current.selectedId).toBe('20'));
    expect(result.current.pendingConversation).toBeNull();
  });
});
