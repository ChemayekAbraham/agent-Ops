import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFunderOperationalFloat, requireFunderOperationalFloat } from '@/components/funder-preview/funderOperationalFloat';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), getSession: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  rpc: mocks.rpc, auth: { getSession: mocks.getSession },
} }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ data: { session: {
    user: { id: 'partner-1' }, access_token: 'test-token',
  } }, error: null });
});

describe('operational float is the only source for home support', () => {
  it.each(['Rent Plan', 'empty house'])('refuses %s support when operational float is short even with withdrawable funds', async () => {
    const wallet = { floatBalance: 194486, withdrawableBalance: 2000000 };
    mocks.rpc.mockResolvedValue({ data: wallet.floatBalance, error: null });
    await expect(requireFunderOperationalFloat('partner-1', 1530000)).rejects.toThrow(/UGX\s1,335,514 short/);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('funder_support_capacity', { p_user_id: 'partner-1' });
    expect(wallet.withdrawableBalance).toBe(2000000);
  });

  it('rechecks float for each confirmation instead of retaining an earlier amount', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 700000, error: null }).mockResolvedValueOnce({ data: 0, error: null });
    await expect(requireFunderOperationalFloat('partner-1', 700000)).resolves.toBeUndefined();
    await expect(requireFunderOperationalFloat('partner-1', 700000)).rejects.toThrow('short');
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it.each([null, undefined, -1, 'not a number'])('does not fall back to another balance for unavailable float %s', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(readFunderOperationalFloat('partner-1')).rejects.toThrow('Operational float is unavailable');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('cannot read float after the session has disappeared', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(requireFunderOperationalFloat('partner-1', 700000)).rejects.toThrow('Sign in');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});