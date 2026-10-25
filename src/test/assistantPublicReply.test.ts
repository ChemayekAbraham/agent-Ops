import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: mocks.getSession } } }));
import { requestAssistantPublicReply } from '@/hooks/assistantPublicReply';
beforeEach(() => {
  vi.restoreAllMocks();
  mocks.getSession.mockResolvedValue({ data: { session: null } });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});
describe('public guidance recovery boundaries', () => {
  it('answers financial queries locally without a model call', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const text = await requestAssistantPublicReply([{ role: 'user', content: 'financial inclusion' }], new AbortController().signal, vi.fn());
    expect(fetch).not.toHaveBeenCalled();
    expect(text).toContain('Public Financial Products & Services Access Guide');
  });
  it('uses rich local guidance when the network is offline', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network unavailable'));
    const text = await requestAssistantPublicReply([{ role: 'user', content: 'hello' }], new AbortController().signal, vi.fn());
    expect(text).toContain('Public Financial Products & Services Access Guide');
  });
  it.each([401, 402, 403, 404, 429, 503])('keeps service status %s visible instead of masking a blocked request', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'SAFE_SERVICE_REASON' }), { status }));
    await expect(requestAssistantPublicReply([{ role: 'user', content: 'hello' }], new AbortController().signal, vi.fn())).rejects.toThrow('SAFE_SERVICE_REASON');
  });
  it('keeps explicit stream refusals terminal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: {"error":"SAFE_DENIAL"}\n\n'));
    await expect(requestAssistantPublicReply([{ role: 'user', content: 'hello' }], new AbortController().signal, vi.fn())).rejects.toThrow('SAFE_DENIAL');
  });
  it('does not mask an empty upstream answer as a successful answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: [DONE]\n\n'));
    await expect(requestAssistantPublicReply([{ role: 'user', content: 'hello' }], new AbortController().signal, vi.fn())).rejects.toThrow('returned no answer');
  });
  it('does not answer after an explicit Stop', async () => {
    const controller = new AbortController(); controller.abort();
    const onText = vi.fn();
    await expect(requestAssistantPublicReply([{ role: 'user', content: 'financial inclusion' }], controller.signal, onText)).rejects.toMatchObject({ name: 'AbortError' });
    expect(onText).not.toHaveBeenCalled();
  });
});