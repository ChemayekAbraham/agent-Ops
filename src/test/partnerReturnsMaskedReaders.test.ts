/**
 * Migration 4b (design v2 §2.2, D9) masks a person's Returns figures for other viewers with SQL NULL.
 * The browser readers must keep those NULLs (never turn them into 0, which would show "UGX 0 Returns"
 * or a wrong total) and keep the person's own figures as numbers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), getSession: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc, auth: { getSession: mocks.getSession }, from: vi.fn() },
}));

import { fetchPartnerWalletHub } from '@/hooks/wallet/usePartnerWalletHub';

const HUB_ROW = {
  withdrawable_amount: 50_000,
  float_amount: 20_000,
  advance_amount: 0,
  deposits_amount: 100_000,
  pending_holds: 0,
  restricted_held: 0,
  recent_transactions: [],
};

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt', expires_at: null } }, error: null });
});

describe('get_partner_wallet_hub reader', () => {
  it("keeps the person's own Returns figures", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ ...HUB_ROW, roi_amount: 30_000, total_available: 100_000 }], error: null });
    const hub = await fetchPartnerWalletHub('u1');
    expect(hub.roiAmount).toBe(30_000);
    expect(hub.totalAvailable).toBe(100_000);
  });

  it('keeps masked Returns and the total that contains them as null (not 0)', async () => {
    mocks.rpc.mockResolvedValue({ data: [{ ...HUB_ROW, roi_amount: null, total_available: null }], error: null });
    const hub = await fetchPartnerWalletHub('u1');
    expect(hub.roiAmount).toBeNull();
    expect(hub.totalAvailable).toBeNull();
    // Figures that are not masked stay as they were.
    expect(hub.withdrawableAmount).toBe(50_000);
    expect(hub.depositsAmount).toBe(100_000);
  });
});
