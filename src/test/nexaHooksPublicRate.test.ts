/**
 * In-app Nexa hooks (design v2 §3.5.9): local guide replies carry the live PUBLIC new-partner rate,
 * and a signed-in person's Portfolio/Returns question goes to the server (their own rate).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: mocks.getSession }, rpc: mocks.rpc, from: mocks.from },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { requestAssistantPublicReply } from '@/hooks/assistantPublicReply';
import { useWelileAI } from '@/hooks/useWelileAI';
import { _resetPublicPartnerRateForTests } from '@/lib/publicPartnerRate';

const SIGNED_IN = { data: { session: { access_token: 'jwt', user: { id: 'u1' } } } };
const SIGNED_OUT = { data: { session: null } };
const sse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);

beforeEach(() => {
  vi.restoreAllMocks();
  _resetPublicPartnerRateForTests();
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: { enabled: false, new_contract_rate: 15 }, error: null });
  mocks.getSession.mockResolvedValue(SIGNED_OUT);
  mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('requestAssistantPublicReply', () => {
  it('passes the live public rate to the local guide', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const text = await requestAssistantPublicReply([{ role: 'user', content: 'financial inclusion' }], new AbortController().signal, vi.fn());
    expect(fetch).not.toHaveBeenCalled();
    expect(text).toContain('New partners earn a 15% Rent profit share per month for 12 months.');
    expect(text).toContain('guaranteed as set out in your partnership agreement.');
    expect(text).not.toMatch(/\b10% per month/);
    expect(mocks.rpc).toHaveBeenCalledWith('get_partner_return_policy');
  });

  it('shows no figure when the rate cannot be read', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    const text = await requestAssistantPublicReply([{ role: 'user', content: 'financial inclusion' }], new AbortController().signal, vi.fn());
    expect(text).not.toMatch(/\d+% per month/);
    expect(text).toContain('New partners earn a 15% Rent profit share per month for 12 months.');
    expect(text).not.toContain('UGX 100,000 illustrates');
  });

  it("sends a signed-in person's Returns question to the server", async () => {
    mocks.getSession.mockResolvedValue(SIGNED_IN);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse('Your own rate is 20%.'));
    const text = await requestAssistantPublicReply([{ role: 'user', content: 'What are supporter returns for supporting a tenant?' }], new AbortController().signal, vi.fn());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(text).toBe('Your own rate is 20%.');
  });

  it('answers the same question locally for a signed-out visitor (public rate)', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const text = await requestAssistantPublicReply([{ role: 'user', content: 'What are supporter returns for supporting a tenant?' }], new AbortController().signal, vi.fn());
    expect(fetch).not.toHaveBeenCalled();
    expect(text).toContain('New partners earn a 15% Rent profit share per month for 12 months.');
  });
});

describe('useWelileAI', () => {
  it('passes the live public rate to the local guide and pitch', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useWelileAI());
    await act(async () => { await result.current.sendMessage('financial inclusion'); });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.messages[1].content).toContain('New partners earn a 15% Rent profit share per month for 12 months.');
    expect(result.current.messages[1].content).not.toMatch(/\b10% per month/);
  });

  it("sends a signed-in person's Returns question to the server", async () => {
    mocks.getSession.mockResolvedValue(SIGNED_IN);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse('Your own rate is 20%.'));
    const { result } = renderHook(() => useWelileAI());
    await act(async () => { await result.current.sendMessage('What are supporter returns for supporting a tenant?'); });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.messages[1].content).toBe('Your own rate is 20%.');
  });
});
