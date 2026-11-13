/*
 * Author: SSENKAALI PIUS
 * Email: ssenkaali.pius@welileapp.com
 * Date: 2026-11-13
 * Website: welileapp.com
 *
 * The real hooks with the Supabase client faked: each action is one round trip, the proof never sends a "read"
 * value from the browser, photos are signed in one batch, and the queue pages with a keyset cursor.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const db = vi.hoisted(() => ({
  rpc: [] as { fn: string; args: Record<string, unknown> }[],
  invoke: [] as { fn: string; body: Record<string, unknown> }[],
  signed: [] as string[][],
  uploads: 0,
  queue: [] as unknown[],
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      db.rpc.push({ fn, args });
      if (fn === 'direct_pay_ops_queue') return { data: db.queue.shift() ?? { can_act: true, rows: [] }, error: null };
      return { data: { ok: true, code: null, payment_id: 'p1', status: 'held' }, error: null };
    }),
    functions: {
      invoke: vi.fn(async (fn: string, { body }: { body: Record<string, unknown> }) => {
        db.invoke.push({ fn, body });
        return { data: { ok: true, code: null, payment_id: body.payment_id, status: 'pending' }, error: null };
      }),
    },
    storage: {
      from: vi.fn(() => ({
        createSignedUrls: vi.fn(async (paths: string[]) => {
          db.signed.push(paths);
          return { data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}` })), error: null };
        }),
      })),
    },
  },
}));
vi.mock('@/lib/funderFundChoice', () => ({
  uploadCashReceiptPhoto: vi.fn(async (rr: string) => {
    db.uploads += 1;
    return `user-1/${rr}-1.jpg`;
  }),
}));

import {
  useDirectPayApprove,
  useDirectPayClaim,
  useDirectPayProofPhotos,
  useDirectPayQueue,
  useDirectPayUploadProof,
} from '../useDirectPay';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  db.rpc = []; db.invoke = []; db.signed = []; db.uploads = 0; db.queue = [];
});

describe('useDirectPay', () => {
  it('claim is one RPC call with the plan id', async () => {
    const { result } = renderHook(() => useDirectPayClaim(), { wrapper });
    await act(async () => { await result.current.mutateAsync('rr-1'); });
    expect(db.rpc).toEqual([{ fn: 'direct_pay_claim', args: { p_rent_request_id: 'rr-1' } }]);
  });

  it('a proof is one upload plus one edge-function call, and carries no "read" values', async () => {
    const { result } = renderHook(() => useDirectPayUploadProof(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ paymentId: 'p1', rentRequestId: 'rr-1', photo: new File(['x'], 'a.jpg'), tidTyped: ' MP12 ' });
    });
    expect(db.uploads).toBe(1);
    expect(db.invoke).toHaveLength(1);
    expect(db.invoke[0].fn).toBe('direct-pay-proof');
    expect(db.invoke[0].body).toEqual({
      payment_id: 'p1', photo_path: 'user-1/rr-1-1.jpg', tid_typed: ' MP12 ', amount_typed: null, provider: null,
    });
    expect(Object.keys(db.invoke[0].body)).not.toContain('read');
    expect(db.rpc).toHaveLength(0);
  });

  it('proof photos for a page are signed in ONE call', async () => {
    const { result } = renderHook(() => useDirectPayProofPhotos(['u/a.jpg', 'u/b.jpg', 'u/c.jpg']), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(db.signed).toEqual([['u/a.jpg', 'u/b.jpg', 'u/c.jpg']]);
    expect(result.current.data?.['u/b.jpg']).toBe('https://signed/u/b.jpg');
  });

  it('the queue pages with the last row as the cursor', async () => {
    const rows = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({
      payment_id: `p${from + i}`, has_flags: false, created_at: `2026-11-17T0${from + i}:00:00Z`, decided_at: null,
    }));
    db.queue = [{ can_act: true, rows: rows(2, 1) }, { can_act: true, rows: rows(1, 3) }];
    const { result } = renderHook(() => useDirectPayQueue('pending', true, 2), { wrapper });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    await act(async () => { await result.current.fetchNextPage(); });
    const calls = db.rpc.filter((c) => c.fn === 'direct_pay_ops_queue');
    expect(calls[0].args).toMatchObject({ p_view: 'pending', p_after_at: null, p_limit: 2 });
    expect(calls[1].args).toMatchObject({ p_after_flagged: false, p_after_at: '2026-11-17T02:00:00Z', p_after_id: 'p2' });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(result.current.hasNextPage).toBe(false);   // the short last page ends the list
  });

  it('approve trims what the officer typed and sends one call', async () => {
    const { result } = renderHook(() => useDirectPayApprove(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ paymentId: 'p1', otp: ' 482913 ', callNote: ' Okello confirmed ', flagReason: '  ' });
    });
    expect(db.rpc).toEqual([{ fn: 'direct_pay_approve', args: {
      p_payment_id: 'p1', p_otp: '482913', p_call_note: 'Okello confirmed', p_flag_reason: null,
    } }]);
  });
});
