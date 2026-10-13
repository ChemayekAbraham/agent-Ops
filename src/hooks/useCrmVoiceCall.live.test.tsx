import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

// Everything below is simulated: no real call, no real voice connection, no real database.
const hangup = vi.fn(() => true);
const call = vi.fn();
const handlers = new Map<string, Set<(p: unknown) => void>>();
vi.mock('@/lib/atVoiceClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/atVoiceClient')>('@/lib/atVoiceClient');
  return {
  // the pure helpers stay real; only the live connection is simulated
  toE164: actual.toE164,
  readHangupCause: actual.readHangupCause,
  muteVoiceCall: vi.fn(),
  getVoiceClient: () => ({ call }),
  onVoiceEvent: (event: string, fn: (p: unknown) => void) => {
    const set = handlers.get(event) ?? new Set();
    set.add(fn);
    handlers.set(event, set);
    return () => set.delete(fn);
  },
  isVoiceClientReady: () => true,
  hangupVoiceCall: () => hangup(),
  resetVoiceClient: vi.fn(),
  stopVoiceMedia: vi.fn(),
  };
});

const rpcCalls: { fn: string; args: unknown }[] = [];
vi.mock('@/integrations/supabase/client', () => {
  const channel = () => { const c: Record<string, unknown> = {}; c.on = () => c; c.subscribe = () => c; return c; };
  return {
    supabase: {
      functions: { invoke: () => Promise.resolve({ data: { token: 'cap-token', clientName: 'staff.1', expiresInSeconds: 3600 }, error: null }) },
      rpc: (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        if (fn === 'crm_start_webrtc_call') return Promise.resolve({ data: { session_id: 's-1', target_phone: '+256700123456' }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      channel,
      removeChannel: vi.fn(),
      from: () => { const c: Record<string, unknown> = {}; c.select = () => c; c.eq = () => c; c.maybeSingle = () => Promise.resolve({ data: null }); return c; },
    },
  };
});
vi.mock('@/hooks/useCrmCallCentre', () => ({ useInvalidateCallViews: () => vi.fn() }));
const report = vi.fn((_input: unknown) => Promise.resolve(true));
vi.mock('@/lib/errorReporting', () => ({ reportClientError: (input: unknown) => report(input) }));

import { useCrmVoiceCall } from './useCrmVoiceCall';
import { isCriticalFlowActive } from '@/lib/criticalFlowGuard';

const target = { calleeId: 't-1', name: 'Test Tenant', phone: '0700123456', role: 'tenant' as const, location: null };

const fireEvent = (event: string, payload?: unknown) => handlers.get(event)?.forEach((fn) => fn(payload));

describe('a live call is protected, and a screen that goes away says why', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcCalls.length = 0;
    handlers.clear();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: vi.fn() }] }) },
    });
  });

  it('while the call is connecting, ringing or connected it is live work: nothing may interrupt it, and leaving the page asks first', async () => {
    const { result, unmount } = renderHook(() => useCrmVoiceCall());
    expect(isCriticalFlowActive()).toBe(false);
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);   // nothing asked while idle

    await act(async () => { await result.current.start(target); });
    await waitFor(() => expect(result.current.state).toBe('calling'));
    expect(isCriticalFlowActive()).toBe(true);
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false); // the browser would ask

    act(() => fireEvent('callaccepted'));
    expect(result.current.state).toBe('connected');
    expect(isCriticalFlowActive()).toBe(true);

    // the other side hangs up: the call is over, so the protection is released
    act(() => fireEvent('hangup', { reason: 'NORMAL_CLEARING' }));
    await waitFor(() => expect(result.current.state).toBe('completed'));
    expect(isCriticalFlowActive()).toBe(false);
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
    unmount();
  });

  it('re-rendering the screen (as an auth event does) neither hangs the call up nor ends the protection', async () => {
    const { result, rerender } = renderHook(() => useCrmVoiceCall());
    await act(async () => { await result.current.start(target); });
    await waitFor(() => expect(result.current.state).toBe('calling'));
    for (let i = 0; i < 5; i += 1) rerender();
    expect(hangup).not.toHaveBeenCalled();
    expect(isCriticalFlowActive()).toBe(true);
    expect(report).not.toHaveBeenCalled();
  });

  it('when the screen is removed during a live call it hangs up as before and records WHY (screen_removed)', async () => {
    const { result, unmount } = renderHook(() => useCrmVoiceCall());
    await act(async () => { await result.current.start(target); });
    await waitFor(() => expect(result.current.state).toBe('calling'));
    act(() => fireEvent('callaccepted'));

    unmount();
    // the existing behaviour is unchanged: the call is hung up and finalised as a cancel from the originator
    expect(hangup).toHaveBeenCalledTimes(1);
    const finalise = rpcCalls.find((c) => c.fn === 'crm_finalize_call_from_client');
    expect(finalise?.args).toMatchObject({ p_session_id: 's-1', p_hangup_cause: 'ORIGINATOR_CANCEL' });
    // and the reason is written down separately, never as part of the call outcome
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({
      label: 'call-screen-removed',
      extra: { reason: 'screen_removed', call_session_id: 's-1', answered: true },
    });
    expect(isCriticalFlowActive()).toBe(false);
  });

  it('a call that already ended leaves nothing to report when its screen goes away', async () => {
    const { result, unmount } = renderHook(() => useCrmVoiceCall());
    await act(async () => { await result.current.start(target); });
    await waitFor(() => expect(result.current.state).toBe('calling'));
    act(() => fireEvent('hangup', { reason: 'NO_ANSWER' }));
    await waitFor(() => expect(result.current.state).toBe('no_answer'));
    unmount();
    expect(report).not.toHaveBeenCalled();
    expect(hangup).not.toHaveBeenCalled();
  });
});
