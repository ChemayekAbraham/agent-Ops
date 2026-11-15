import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));

import {
  LANDLORD_CODE_UNKNOWN, isLandlordReferralCode, landlordCodeFromSearch, normalizeLandlordCode, recordLandlordReferral,
} from '@/lib/landlordReferral';

beforeEach(() => mocks.rpc.mockReset());

describe('E107: landlord referral codes', () => {
  it('a code is L + 8 letters or numbers, however it is typed', () => {
    expect(normalizeLandlordCode(' l4k7-q2m9x ')).toBe('L4K7Q2M9X');
    expect(isLandlordReferralCode('L4K7Q2M9X')).toBe(true);
    expect(isLandlordReferralCode('l4k7q2m9x')).toBe(true);
    expect(isLandlordReferralCode('L4K7Q2M9')).toBe(false);
    expect(isLandlordReferralCode('X4K7Q2M9X')).toBe(false);
    expect(isLandlordReferralCode('11111111-2222-4333-8444-555555555555')).toBe(false);
  });

  it('reads ?ref=CODE from a link, and ignores an agent id in ?ref', () => {
    expect(landlordCodeFromSearch('?ref=l4k7q2m9x')).toBe('L4K7Q2M9X');
    expect(landlordCodeFromSearch('?become=tenant&ref=L4K7Q2M9X')).toBe('L4K7Q2M9X');
    expect(landlordCodeFromSearch('?ref=11111111-2222-4333-8444-555555555555&become=tenant')).toBe('');
    expect(landlordCodeFromSearch('')).toBe('');
  });

  it('records the code on the saved request', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ok: true }, error: null });
    await expect(recordLandlordReferral('req-1', 'l4k7q2m9x')).resolves.toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith('landlord_referral_record', { p_rent_request_id: 'req-1', p_code: 'L4K7Q2M9X' });
  });

  it('an unknown code says "Code not recognised"; other refusals come back as written; it never throws', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ok: false, reason: 'unknown_code' }, error: null });
    await expect(recordLandlordReferral('req-1', 'LZZZZZZZZ')).resolves.toEqual({ ok: false, message: LANDLORD_CODE_UNKNOWN });
    expect(LANDLORD_CODE_UNKNOWN).toBe('Code not recognised');
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'NOT_YOUR_REQUEST' } });
    await expect(recordLandlordReferral('req-1', 'L4K7Q2M9X')).resolves.toEqual({ ok: false, message: 'NOT_YOUR_REQUEST' });
    mocks.rpc.mockRejectedValueOnce(new Error('Failed to fetch'));
    await expect(recordLandlordReferral('req-1', 'L4K7Q2M9X')).resolves.toEqual({ ok: false, message: 'Failed to fetch' });
  });

  it('no code, no call', async () => {
    await expect(recordLandlordReferral('req-1', '  ')).resolves.toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
