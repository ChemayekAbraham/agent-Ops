import { beforeEach, describe, expect, it, vi } from 'vitest';

const sb = vi.hoisted(() => ({
  upload: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: sb.rpc,
    storage: { from: (bucket: string) => { sb.from(bucket); return { upload: sb.upload }; } },
  },
}));
vi.mock('@/lib/imageOptimizer', () => ({
  optimizeImage: vi.fn(async (file: File) => ({ file: new File([file], 'opt.jpg', { type: 'image/jpeg' }) })),
}));

import {
  AGENT_AGREEMENT_PATH, MOBILE_MONEY_SETTINGS_PATH, classifyMissing, fetchGateStatus, fetchV2Missing,
  homeLc1Path, parseGateStatus, parseV2Missing, saveHomeLc1, verifiedUntilLabel,
} from '@/lib/agentVettingV2';

beforeEach(() => {
  sb.upload.mockReset().mockResolvedValue({ error: null });
  sb.from.mockReset();
  sb.rpc.mockReset().mockResolvedValue({ data: { success: true }, error: null });
});

describe('home LC1 letter', () => {
  it('builds the path under the agent\'s own user id', () => {
    expect(homeLc1Path('uid-1', 1700000000000)).toBe('uid-1/vetting/home_lc1_1700000000000.jpg');
  });

  it('uploads to lc-letters, then records it with agent_vetting_save_home_lc1', async () => {
    const file = new File(['x'], 'letter.png', { type: 'image/png' });
    const res = await saveHomeLc1('uid-1', file, 42);
    expect(sb.from).toHaveBeenCalledWith('lc-letters');
    expect(sb.upload).toHaveBeenCalledWith('uid-1/vetting/home_lc1_42.jpg', expect.any(File), expect.objectContaining({ upsert: false, contentType: 'image/jpeg' }));
    expect(sb.rpc).toHaveBeenCalledWith('agent_vetting_save_home_lc1', { p_bucket: 'lc-letters', p_path: 'uid-1/vetting/home_lc1_42.jpg' });
    expect(sb.upload.mock.invocationCallOrder[0]).toBeLessThan(sb.rpc.mock.invocationCallOrder[0]);
    expect(res).toEqual({ bucket: 'lc-letters', path: 'uid-1/vetting/home_lc1_42.jpg' });
  });

  it('does not call the RPC when the upload fails, and passes the storage error on', async () => {
    sb.upload.mockResolvedValue({ error: { message: 'new row violates row-level security policy' } });
    await expect(saveHomeLc1('uid-1', new File(['x'], 'a.jpg'))).rejects.toThrow('new row violates row-level security policy');
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it('shows the server message as it is', async () => {
    sb.rpc.mockResolvedValue({ data: null, error: { message: 'LC1_PATH: the letter must be in your own folder' } });
    await expect(saveHomeLc1('uid-1', new File(['x'], 'a.jpg'))).rejects.toThrow('LC1_PATH: the letter must be in your own folder');
    sb.rpc.mockResolvedValue({ data: { success: false, message: 'Letter already on file' }, error: null });
    await expect(saveHomeLc1('uid-1', new File(['x'], 'a.jpg'))).rejects.toThrow('Letter already on file');
  });
});

describe('what is still missing', () => {
  it('reads text[], jsonb arrays of objects and { missing }', () => {
    expect(parseV2Missing(['Signed agent agreement', ' ', 'LC1 letter for your home'])).toEqual(['Signed agent agreement', 'LC1 letter for your home']);
    expect(parseV2Missing([{ key: 'agreement', label: 'Signed agent agreement' }])).toEqual(['Signed agent agreement']);
    expect(parseV2Missing({ missing: ['Mobile money in your own name'] })).toEqual(['Mobile money in your own name']);
    expect(parseV2Missing(null)).toEqual([]);
  });

  it('calls _agent_vetting_v2_missing with the agent\'s own id', async () => {
    sb.rpc.mockResolvedValue({ data: ['Signed agent agreement'], error: null });
    await expect(fetchV2Missing('uid-1')).resolves.toEqual(['Signed agent agreement']);
    expect(sb.rpc).toHaveBeenCalledWith('_agent_vetting_v2_missing', { p_agent: 'uid-1' });
  });

  it('links the agreement and mobile money lines, and maps the rest to wizard steps', () => {
    expect(classifyMissing('Signed agent agreement')).toMatchObject({ kind: 'agreement', href: AGENT_AGREEMENT_PATH });
    expect(classifyMissing('Mobile money in your own name')).toMatchObject({ kind: 'mobile_money', href: MOBILE_MONEY_SETTINGS_PATH });
    expect(MOBILE_MONEY_SETTINGS_PATH).toBe('/settings?section=account&tab=withdrawal');
    expect(classifyMissing('LC1 letter for your home')).toMatchObject({ kind: 'home_lc1', step: 'home_lc1' });
    expect(classifyMissing('Capture your location')).toMatchObject({ kind: 'step', step: 'location' });
    expect(classifyMissing('Next of kin phone')).toMatchObject({ kind: 'step', step: 'next_of_kin' });
    expect(classifyMissing('Something new')).toMatchObject({ kind: 'other', step: null, href: null, text: 'Something new' });
  });
});

describe('gate status', () => {
  it('reads expires_at and the reason', async () => {
    sb.rpc.mockResolvedValue({ data: { enforced: true, status: 'expired', blocked: true, reason: 'Verify again', expires_at: '2026-11-01T00:00:00Z' }, error: null });
    await expect(fetchGateStatus('uid-1')).resolves.toEqual({ enforced: true, status: 'expired', blocked: true, reason: 'Verify again', expires_at: '2026-11-01T00:00:00Z' });
    expect(sb.rpc).toHaveBeenCalledWith('agent_vetting_gate_status', { p_agent_id: 'uid-1' });
    expect(parseGateStatus(null)).toEqual({ enforced: false, status: null, blocked: false, reason: null, expires_at: null });
  });

  it('formats "Verified until" in Kampala time', () => {
    expect(verifiedUntilLabel('2027-11-11T22:30:00Z')).toBe('Verified until 12 Nov 2027');
    expect(verifiedUntilLabel(null)).toBeNull();
    expect(verifiedUntilLabel('not a date')).toBeNull();
  });
});
