import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

import {
  FOLLOWUP_LOOKUP_CHUNK, fetchShortfallFollowupsLatest, useRecordShortfallFollowup, useShortfallFollowupsLatest,
} from './useShortfallFollowups';
import { describeFollowup, timeAgoShort } from './shortfallFollowupLabels';

const latest = (id: string, extra: Record<string, unknown> = {}) => ({
  rent_request_id: id, followup_id: `f-${id}`, outcome: 'no_answer', note: 'Phone rang out', promised_date: null,
  created_at: '2026-10-05T10:00:00+00:00', actor_id: 'u1', actor_name: 'Grace', followup_count: '2', ...extra,
});

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> };
}

describe('fetchShortfallFollowupsLatest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keys rows by Rent Plan and coerces the count', async () => {
    rpcMock.mockResolvedValue({ data: [latest('a')], error: null });
    const out = await fetchShortfallFollowupsLatest(['a', 'b', 'a']);
    expect(rpcMock).toHaveBeenCalledWith('tops_shortfall_followups_latest', { p_rent_request_ids: ['a', 'b'] });
    expect(Object.keys(out)).toEqual(['a']);
    expect(out.a.followup_count).toBe(2);
  });

  it('splits more than 1000 ids into several calls', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const ids = Array.from({ length: FOLLOWUP_LOOKUP_CHUNK * 2 + 5 }, (_, i) => `id-${i}`);
    await fetchShortfallFollowupsLatest(ids);
    expect(rpcMock.mock.calls.map((c) => (c[1].p_rent_request_ids as string[]).length)).toEqual([1000, 1000, 5]);
  });

  it('throws the RPC error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'not authorized' } });
    await expect(fetchShortfallFollowupsLatest(['a'])).rejects.toMatchObject({ message: 'not authorized' });
  });
});

describe('useShortfallFollowupsLatest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not call the server for an empty list', async () => {
    const { wrapper } = makeWrapper();
    renderHook(() => useShortfallFollowupsLatest([]), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe('useRecordShortfallFollowup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the plan, outcome, note and date, then refreshes the follow-up and list queries', async () => {
    rpcMock.mockResolvedValue({ data: { id: 'new' }, error: null });
    const { qc, wrapper } = makeWrapper();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRecordShortfallFollowup(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ rentRequestId: 'rr-1', outcome: 'reached_will_pay', note: 'Will pay Friday', promisedDate: '2026-10-09' });
    });
    expect(rpcMock).toHaveBeenCalledWith('tops_record_shortfall_followup', {
      p_rent_request_id: 'rr-1', p_outcome: 'reached_will_pay', p_note: 'Will pay Friday', p_promised_date: '2026-10-09',
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[1])).toEqual(['shortfallFollowups', 'shortfallDetail']);
  });

  it('sends a null date when none is given and surfaces a server refusal', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'not authorized' } });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useRecordShortfallFollowup(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ rentRequestId: 'rr-1', outcome: 'no_answer', note: 'Phone rang out' })).rejects.toBeTruthy();
    });
    expect(rpcMock.mock.calls[0][1].p_promised_date).toBeNull();
  });
});

describe('follow-up wording', () => {
  const now = new Date('2026-10-05T12:00:00+03:00');

  it('says how long ago in short form', () => {
    expect(timeAgoShort('2026-10-05T11:59:40+03:00', now)).toBe('just now');
    expect(timeAgoShort('2026-10-05T11:25:00+03:00', now)).toBe('35m ago');
    expect(timeAgoShort('2026-10-05T10:00:00+03:00', now)).toBe('2h ago');
    expect(timeAgoShort('2026-10-02T12:00:00+03:00', now)).toBe('3d ago');
    expect(timeAgoShort('2026-08-01T12:00:00+03:00', now)).toBe('01 Aug 2026');
  });

  it('builds the "Followed up 2h ago: will pay Friday" line and flags a passed promise', () => {
    const f = { ...latest('a', { outcome: 'reached_will_pay', promised_date: '2026-10-09', created_at: '2026-10-05T10:00:00+03:00' }), followup_count: 1 } as never;
    const s = describeFollowup(f, now);
    expect(s.line).toBe('Followed up 2h ago: will pay Fri 9 Oct');
    expect(s.promisePassed).toBe(false);
    expect(describeFollowup({ ...(f as object), promised_date: '2026-10-04' } as never, now).promisePassed).toBe(true);
    // only a "will pay" promise can pass
    expect(describeFollowup({ ...(f as object), outcome: 'no_answer', promised_date: null } as never, now).line)
      .toBe('Followed up 2h ago: no answer');
  });
});
