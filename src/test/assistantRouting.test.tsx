import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptsPersonalAnswer, isPersonalAgentWorkQuery } from '@/lib/assistantRouting';
const mock = vi.hoisted(() => ({ user: null as null | { id: string }, invoke: vi.fn(), publicReply: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mock.user }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: mock.invoke } } }));
vi.mock('@/hooks/assistantPublicReply', () => ({ requestAssistantPublicReply: mock.publicReply }));
import { useAgentAssistant } from '@/hooks/useAgentAssistant';

beforeEach(() => { mock.user = null; mock.invoke.mockReset(); mock.publicReply.mockReset(); mock.publicReply.mockImplementation(async (_turns, _signal, onText) => { onText('PUBLIC_GUIDE'); return 'PUBLIC_GUIDE'; }); });
describe('assistant routing and privacy', () => {
  it.each(['How much did I collect today?', 'What is remaining to collect today?', 'How many tenants am I collecting for?', 'Why is my collection low today?', 'What is my wallet balance?', 'Do I have any advances?'])('routes personal starter %s to protected work handling', question => expect(isPersonalAgentWorkQuery(question)).toBe(true));
  it.each(['How does the Welile Wallet work?', 'Support a tenant & earn 15%/mo', 'What is Welile?', 'How do I deposit into my wallet?'])('does not send public guide %s to work handling', question => expect(isPersonalAgentWorkQuery(question)).toBe(false));
  it.each(['out_of_scope', 'not_an_agent', 'unmatched', 'not_enabled', 'error'])('does not accept %s as a personal answer', outcome => expect(acceptsPersonalAnswer({ outcome, reply: 'NO_PRIVATE_ANSWER' })).toBe(false));
  it.each(['answered', 'clarify'])('accepts a valid %s personal answer', outcome => expect(acceptsPersonalAnswer({ outcome, reply: 'PERSONAL_ANSWER' })).toBe(true));
  it('never calls personal service while signed out', async () => {
    const { result } = renderHook(useAgentAssistant);
    await act(async () => { await result.current.send('What is my wallet balance?'); });
    expect(mock.invoke).not.toHaveBeenCalled(); expect(mock.publicReply).toHaveBeenCalledOnce();
    expect(result.current.messages.at(-1)?.content).toBe('PUBLIC_GUIDE');
  });
  it('uses the authorized personal answer without a public call', async () => {
    mock.user = { id: 'TEST_USER_A' }; mock.invoke.mockResolvedValue({ data: { outcome: 'answered', reply: 'PRIVATE_WORK', conversation_id: 'SERVER_ID' }, error: null });
    const { result } = renderHook(useAgentAssistant);
    await act(async () => { await result.current.send('How much did I collect today?'); });
    expect(mock.publicReply).not.toHaveBeenCalled(); expect(result.current.messages.at(-1)?.content).toBe('PRIVATE_WORK');
    expect(mock.invoke.mock.calls[0][1].body).not.toHaveProperty('history');
  });
  it.each(['out_of_scope', 'not_an_agent', 'unmatched', 'not_enabled', 'error'])('falls back on personal outcome %s', async outcome => {
    mock.user = { id: 'TEST_USER_A' }; mock.invoke.mockResolvedValue({ data: { outcome, reply: 'NOT_AN_ANSWER' }, error: null });
    const { result } = renderHook(useAgentAssistant);
    await act(async () => { await result.current.send('What is my wallet balance?'); });
    expect(result.current.messages.at(-1)?.content).toBe('PUBLIC_GUIDE');
  });
  it('does not send private replies to the public service and clears on account changes', async () => {
    mock.user = { id: 'TEST_USER_A' }; mock.invoke.mockResolvedValue({ data: { outcome: 'answered', reply: 'PRIVATE_WORK' }, error: null });
    const { result, rerender } = renderHook(useAgentAssistant);
    await act(async () => { await result.current.send('How much did I collect today?'); await result.current.send('What is Welile?'); });
    expect(JSON.stringify(mock.publicReply.mock.calls[0][0])).not.toContain('PRIVATE_WORK');
    mock.user = { id: 'TEST_USER_B' }; rerender(); await waitFor(() => expect(result.current.messages).toEqual([]));
  });
  it('discards an in-flight answer after reset', async () => {
    mock.user = { id: 'TEST_USER_A' }; let complete: (value: unknown) => void = () => {};
    mock.invoke.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const { result } = renderHook(useAgentAssistant);
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.send('How much did I collect today?'); });
    act(() => result.current.reset());
    await act(async () => { complete({ data: { outcome: 'answered', reply: 'STALE_PRIVATE_WORK' }, error: null }); await pending; });
    expect(result.current.messages).toEqual([]); expect(result.current.isLoading).toBe(false);
  });
});
