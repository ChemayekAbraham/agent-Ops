import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), auth } }));

import { FUNNEL_QUEUE_KEY, createFormFunnel, flushFunnelQueue, funnelErrorCode, type FunnelRow } from '@/lib/formFunnel';

const setOnline = (v: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, value: v });
const queued = (): FunnelRow[] => JSON.parse(localStorage.getItem(FUNNEL_QUEUE_KEY) || '[]');
/** Lets the fire-and-forget sends settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let rpc: ReturnType<typeof vi.fn>;
const rows = () => rpc.mock.calls.map(([, row]) => row as FunnelRow);

beforeEach(() => {
  auth.getSession.mockReset();
  auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'agent-1' }, access_token: 'test-token' } }, error: null });
  localStorage.clear();
  setOnline(true);
  rpc = vi.fn(async () => ({ error: null }));
});
afterEach(() => setOnline(true));

describe('E108 form funnel: sessions', () => {
  it('keeps one session across steps, sends the right fields, and starts a new one after a post', async () => {
    const f = createFormFunnel('agent_post', rpc);
    f.open();
    f.step('start');
    f.step('start'); // same step: once
    f.step('repayment');
    f.blocked(['rent']);
    f.itemDone('rent');
    f.itemDone('rent'); // once per session
    f.submitOk('req-1');
    f.close(); // posted: no close
    await settle();
    const first = rows();
    expect(first.map((r) => r.p_event)).toEqual(['open', 'step', 'step', 'blocked', 'item_done', 'submit_ok']);
    expect(new Set(first.map((r) => r.p_session)).size).toBe(1);
    expect(first.every((r) => r.p_form === 'agent_post')).toBe(true);
    expect(first[3]).toMatchObject({ p_step: 'repayment', p_items: ['rent'], p_error: null });
    expect(first[5]).toMatchObject({ p_rent_request_id: 'req-1' });
    expect(rpc).toHaveBeenCalledWith('request_form_log', expect.objectContaining({ p_event: 'open' }));

    f.open();
    f.step('start');
    await settle();
    const second = rows().slice(first.length);
    expect(second[0].p_session).not.toBe(first[0].p_session);
    expect(second.every((r) => r.p_session === second[0].p_session)).toBe(true);
  });

  it('a form closed without posting logs close once, and reopening is a new session', async () => {
    const f = createFormFunnel('tenant_self', rpc);
    f.open();
    const s1 = f.session;
    f.close();
    f.close();
    f.open();
    await settle();
    expect(rows().map((r) => r.p_event)).toEqual(['open', 'close', 'open']);
    expect(f.session).not.toBe(s1);
  });

  it('only sends the allowed item codes; an empty blocked list becomes ["other"]', async () => {
    const f = createFormFunnel('agent_post', rpc);
    f.open();
    f.blocked(['id_front', 'id_front', 'nonsense' as never]);
    f.blocked([]);
    f.submitFail('REQUIREMENTS_MISSING', ['lc1_letter']);
    await settle();
    expect(rows().slice(1).map((r) => [r.p_event, r.p_items, r.p_error])).toEqual([
      ['blocked', ['id_front'], null],
      ['blocked', ['other'], null],
      ['submit_fail', ['lc1_letter'], 'REQUIREMENTS_MISSING'],
    ]);
  });

  it('reads the server error code from a message', () => {
    expect(funnelErrorCode('REQUIREMENTS_MISSING: add the LC1 letter')).toBe('REQUIREMENTS_MISSING');
    expect(funnelErrorCode('Another agent just reserved this house.', 'house_taken')).toBe('house_taken');
  });
});

describe('E108 form funnel: offline queue', () => {
  it('queues while offline, then sends everything in order once online', async () => {
    setOnline(false);
    const f = createFormFunnel('agent_post', rpc);
    f.open();
    f.step('start');
    await settle();
    expect(rpc).not.toHaveBeenCalled();
    expect(queued().map((r) => r.p_event)).toEqual(['open', 'step']);
    expect(queued()[0].p_meta).toHaveProperty('client_at');

    setOnline(true);
    await flushFunnelQueue(rpc);
    expect(rows().map((r) => r.p_event)).toEqual(['open', 'step']);
    expect(queued()).toEqual([]);
  });

  it('a dropped connection queues the row; a server refusal is not retried', async () => {
    const f = createFormFunnel('agent_post', vi.fn(async () => ({ error: { message: 'TypeError: Failed to fetch' } })));
    f.open();
    await settle();
    expect(queued().map((r) => r.p_event)).toEqual(['open']);

    localStorage.clear();
    const g = createFormFunnel('agent_post', vi.fn(async () => ({ error: { message: 'permission denied for function request_form_log' } })));
    g.open();
    await settle();
    expect(queued()).toEqual([]);
  });

  it('a later successful send also flushes what waited', async () => {
    setOnline(false);
    const f = createFormFunnel('agent_post', rpc);
    f.open();
    await settle();
    setOnline(true);
    f.step('start');
    await settle();
    await settle();
    expect(rows().map((r) => r.p_event).sort()).toEqual(['open', 'step']);
    expect(queued()).toEqual([]);
  });
});

describe('E108 form funnel: never throws', () => {
  it('skips signed-out events, including queue replay, without retrying', async () => {
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const f = createFormFunnel('agent_post', rpc);
    f.open();
    f.step('start');
    await settle();
    await flushFunnelQueue(rpc);
    expect(rpc).not.toHaveBeenCalled();
    expect(queued()).toEqual([]);
  });

  it('skips expired sessions and swallowed session failures', async () => {
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'agent-1' }, access_token: 'expired', expires_at: 1 } }, error: null });
    createFormFunnel('agent_post', rpc).open();
    await settle();
    auth.getSession.mockRejectedValue(new Error('session unavailable'));
    createFormFunnel('agent_post', rpc).open();
    await settle();
    expect(rpc).not.toHaveBeenCalled();
    expect(queued()).toEqual([]);
  });

  it('does not replay permission refusals or unexpected rejected calls', async () => {
    rpc.mockResolvedValue({ error: { message: 'permission denied for function request_form_log' } });
    createFormFunnel('agent_post', rpc).open();
    await settle();
    await flushFunnelQueue(rpc);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(queued()).toEqual([]);
    rpc.mockRejectedValue(new Error('unexpected failure'));
    createFormFunnel('agent_post', rpc).open();
    await settle();
    await flushFunnelQueue(rpc);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(queued()).toEqual([]);
  });

  it('survives an rpc that throws, rejects, or returns nothing, and broken storage', async () => {
    const throwing = vi.fn(() => { throw new Error('boom'); });
    const rejecting = vi.fn(async () => { throw new Error('Failed to fetch'); });
    const empty = vi.fn(async () => undefined as never);
    for (const r of [throwing, rejecting, empty]) {
      const f = createFormFunnel('agent_post', r);
      expect(() => { f.open(); f.step('start'); f.blocked(['gps']); f.submitFail('X'); f.close(); }).not.toThrow();
    }
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); });
    setOnline(false);
    const f = createFormFunnel('tenant_self', rpc);
    expect(() => { f.open(); f.step('tenant'); }).not.toThrow();
    await settle();
    await expect(flushFunnelQueue(rpc)).resolves.toBeUndefined();
    setItem.mockRestore();
  });

  it('ignores everything before open', async () => {
    const f = createFormFunnel('agent_post', rpc);
    f.step('start'); f.blocked(['rent']); f.itemDone('rent'); f.submitOk('x'); f.submitFail('X'); f.close();
    await settle();
    expect(rpc).not.toHaveBeenCalled();
  });
});
