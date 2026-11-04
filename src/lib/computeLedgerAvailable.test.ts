/**
 * Regression coverage for the "Available: UGX 0" incident (2026-08-15,
 * Gloria Namatovu) — a failed `get_user_wallet_view` RPC read (timeout /
 * transient network / expired token) must surface as a thrown error, not
 * a fabricated `available: 0`. WithdrawFlow treats a thrown/null result
 * as UNKNOWN and falls back to the last-known wallet figure; treating a
 * failed read as a verified zero blocks withdrawals with no real cause.
 */
import { describe, it, expect, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({
    data: {
      session: {
        access_token: 'jwt',
        expires_at: Math.floor(Date.now() / 1000) + 600,
      },
    },
    error: null,
  })),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(),
    auth: { getSession: () => auth.getSession() },
  },
}));

import { supabase } from '@/integrations/supabase/client';
import { computeLedgerAvailable } from './computeLedgerAvailable';

const rpcMock = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

describe('computeLedgerAvailable', () => {
  it('returns the strict ledger withdrawable figure on success', async () => {
    rpcMock.mockResolvedValueOnce({
      data: { withdrawable: 325987, pending_holds: 0 },
      error: null,
    });
    const result = await computeLedgerAvailable('user-1');
    expect(result.available).toBe(325987);
    expect(result.withdrawableCached).toBe(325987);
    expect(result.pendingHolds).toBe(0);
  });

  it('throws instead of fabricating a zero when the RPC errors', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'upstream timeout' },
    });
    await expect(computeLedgerAvailable('user-1')).rejects.toThrow(/upstream timeout/);
  });

  it('resolves to 0 only when the RPC succeeds with no row (genuine empty wallet)', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    const result = await computeLedgerAvailable('user-1');
    expect(result.available).toBe(0);
  });

  it('throws before the RPC when there is no signed-in session', async () => {
    rpcMock.mockClear();
    auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    await expect(computeLedgerAvailable('user-1')).rejects.toThrow(/Sign in again/);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
