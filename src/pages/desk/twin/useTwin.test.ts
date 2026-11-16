import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readTwin } from './twinModel';
import type { TwinSource } from './twinSource';
import { useTwin } from './useTwin';
import { LIVE } from './twinFixture';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

afterEach(cleanup);

type Handler = (msg: { new?: Record<string, unknown> }) => void;

function fakeRealtime() {
  const handlers = new Map<string, Handler>();
  const channel = {
    on: (_kind: string, filter: { table: string }, cb: Handler) => {
      handlers.set(filter.table, cb);
      return channel;
    },
    subscribe: () => channel,
  };
  const client = { channel: vi.fn(() => channel), removeChannel: vi.fn(() => Promise.resolve('ok')) };
  return { client, channel, handlers };
}

describe('useTwin realtime', () => {
  it('listens to stage events and run signals only, and reloads history through the RPC on a signal', async () => {
    const rt = fakeRealtime();
    const history = vi.fn(() => Promise.resolve([]));
    const source: TwinSource = {
      kind: 'staff',
      now: () => Promise.resolve(readTwin(LIVE)),
      day: () => Promise.resolve(null),
      history,
      realtime: rt.client as unknown as SupabaseClient,
    };
    const { result, unmount } = renderHook(() => useTwin(source));
    await waitFor(() => expect(result.current.twin).not.toBeNull());

    expect([...rt.handlers.keys()].sort()).toEqual(['ops_twin_run_signals', 'rent_request_stage_events']);
    expect(rt.handlers.has('ops_twin_runs')).toBe(false);

    const before = history.mock.calls.length;
    act(() => rt.handlers.get('ops_twin_run_signals')!({ new: { run_id: 12, run_at: '2026-11-16T05:00:00Z', window_end: '2026-11-16T05:00:00Z', source: 'cron' } }));
    await waitFor(() => expect(history.mock.calls.length).toBe(before + 1));

    act(() => rt.handlers.get('rent_request_stage_events')!({ new: { from_status: 'pending', to_status: 'agent_verified' } }));
    expect(result.current.liveMoves).toHaveLength(1);

    unmount();
    expect(rt.client.removeChannel).toHaveBeenCalledWith(rt.channel);
  });
});
