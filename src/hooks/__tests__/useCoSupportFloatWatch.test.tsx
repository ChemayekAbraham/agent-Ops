import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// The real hook, with the Supabase client faked: the preview RPC and the
// deposit row are whatever each test says.
const db = vi.hoisted(() => ({
  preview: { found: true, reason: 'funds_short', float_needed: 10, can_accept: false } as Record<string, unknown>,
  depositStatus: 'pending' as string | null,
  rpcCalls: 0,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(async () => {
      db.rpcCalls += 1;
      return { data: db.preview, error: null };
    }),
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: db.depositStatus ? { status: db.depositStatus } : null, error: null }) }),
      }),
    })),
    storage: { from: vi.fn() },
  },
}));

import { useCoSupportFloatWatch } from '../useCoSupport';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useCoSupportFloatWatch', () => {
  beforeEach(() => {
    db.preview = { found: true, reason: 'funds_short', float_needed: 10, can_accept: false };
    db.depositStatus = 'pending';
    db.rpcCalls = 0;
  });

  it('is idle and fetches nothing before a deposit is submitted', () => {
    const { result } = renderHook(() => useCoSupportFloatWatch('AB12CD34EF56', 'u1', null), { wrapper });
    expect(result.current.state).toBe('idle');
    expect(db.rpcCalls).toBe(0);
  });

  it('does not crash once a deposit is submitted, and waits while still short', async () => {
    const deposit = { id: 'dep-1', submittedAt: Date.now() };
    const { result } = renderHook(() => useCoSupportFloatWatch('AB12CD34EF56', 'u1', deposit), { wrapper });
    await waitFor(() => expect(result.current.preview).not.toBeNull());
    expect(result.current.state).toBe('waiting');
  });

  it('reports arrived when the server says they can join', async () => {
    db.preview = { found: true, reason: null, float_needed: 0, can_accept: true, float_available: 1530000 };
    db.depositStatus = 'approved';
    const deposit = { id: 'dep-1', submittedAt: Date.now() };
    const { result } = renderHook(() => useCoSupportFloatWatch('AB12CD34EF56', 'u1', deposit), { wrapper });
    await waitFor(() => expect(result.current.state).toBe('arrived'));
    expect(result.current.preview?.float_available).toBe(1530000);
  });

  it('reports rejected when the deposit is rejected', async () => {
    db.depositStatus = 'rejected';
    const deposit = { id: 'dep-1', submittedAt: Date.now() };
    const { result } = renderHook(() => useCoSupportFloatWatch('AB12CD34EF56', 'u1', deposit), { wrapper });
    await waitFor(() => expect(result.current.state).toBe('rejected'));
  });
});
