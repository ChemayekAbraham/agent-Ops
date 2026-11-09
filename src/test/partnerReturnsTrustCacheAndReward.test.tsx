/**
 * Partner Returns Phase 4 browser data code, second round:
 * - B1 the trust-profile cache belongs to the viewer who fetched it (shared office devices): keyed by
 *   viewer, other viewers' and unowned copies dropped on read, signed-in copies dropped on sign-out;
 * - B2 the rent-facilitation reward is priced at a rate the database gives (null rate -> no figure);
 * - B3 trust figures masked by 4b (null) are unknown, never 0, in the share text;
 * - B4 a contact mismatch on note activation always says Partner Ops can link the note.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type AuthCallback = (event: string, session: { user: { id: string } } | null) => void;
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  viewer: null as string | null,
  authCallbacks: [] as AuthCallback[],
  unsubscribe: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    auth: {
      getSession: () => Promise.resolve({ data: { session: mocks.viewer ? { user: { id: mocks.viewer } } : null }, error: null }),
      onAuthStateChange: (cb: AuthCallback) => {
        mocks.authCallbacks.push(cb);
        return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
      },
    },
  },
}));

import { useTrustProfile, type TrustProfile } from '@/hooks/useTrustProfile';
import {
  TRUST_PROFILE_CACHE_TTL_MS,
  clearTrustProfileCaches,
  readTrustProfileCache,
  trustProfileCacheKey,
  writeTrustProfileCache,
} from '@/lib/trustProfileCache';
import { clearSessionCache } from '@/lib/sessionCache';
import {
  calculateSupporterReward,
  calculateSupporterRewardAt,
  formatUGX,
  formatUGXOrDash,
  sumSupporterRewardsAt,
} from '@/lib/rentCalculations';
import { buildWhatsAppMessage, shownVouchLimit } from '@/lib/shareTrustProfile';
import { activationErrorFrom } from '@/lib/promissoryNoteActivation';

const AI = 'WEL-ABC123';
const trustKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('welile_trust_profile_')).sort();

function profileFor(viewer: string, limit: number | null = 1_050_000): TrustProfile {
  return {
    ai_id: AI,
    user_id: 'subject',
    identity: {
      full_name: `Seen by ${viewer}`, phone: null, email: null, national_id: null, national_id_present: false,
      avatar_url: null, verified: true, member_since: '2025-01-01T00:00:00Z', roles: ['supporter'], primary_role: 'supporter',
    },
    trust: {
      score: 40, tier: 'standard', data_points: 6, borrowing_limit_ugx: limit,
      breakdown: { supporter: null, payment: 0, wallet: 5, network: 2, verification: 3, behavior: 0, landlord: 0 },
      weights: { payment: 15, wallet: 10, network: 15, verification: 10, behavior: 5, landlord: 5 },
    },
    payment_history: { total_rent_plans: 0, total_repaid: 0, total_owing: 0, on_time_count: 0, late_count: 0, on_time_rate: 0 },
    wallet_activity: { balance: null, total_received_180d: 0, total_sent_180d: 0, transaction_count_180d: 0 },
    cash_flow_capacity: { daily_avg: null, weekly_avg: null, monthly_avg: null, window_days: 90 },
    network: { referrals: 0, sub_agents: 0, tenants_onboarded: 0, portfolio_value: null },
    behavior: { visits_total_60d: 0, always_share_location: false },
    landlord_activity: { total_listings: 0, verified_listings: 0, guaranteed_rent: false },
    permissions: { is_self: false, is_staff_view: false, can_see_pii: false },
    generated_at: '2026-11-07T00:00:00Z',
  };
}

beforeEach(() => {
  localStorage.clear();
  mocks.rpc.mockReset();
  mocks.viewer = null;
  mocks.authCallbacks.length = 0;
  mocks.unsubscribe.mockReset();
});

describe('trust-profile cache (B1)', () => {
  it('keys every copy by the viewer; signed out is its own viewer', () => {
    expect(trustProfileCacheKey('u-1', ' wel-abc123 ', false)).toBe('welile_trust_profile_u-1:WEL-ABC123');
    expect(trustProfileCacheKey('u-1', AI, true)).toBe('welile_trust_profile_u-1:pub_WEL-ABC123');
    expect(trustProfileCacheKey(null, AI, true)).toBe('welile_trust_profile_anon:pub_WEL-ABC123');
  });

  it("never returns another viewer's copy, and drops other viewers' and unowned copies when read", () => {
    writeTrustProfileCache('staff-1', AI, false, profileFor('staff-1'));
    writeTrustProfileCache(null, AI, true, profileFor('anon'));
    localStorage.setItem(`welile_trust_profile_${AI}`, JSON.stringify({ data: profileFor('legacy'), cachedAt: Date.now() }));
    localStorage.setItem(`welile_trust_profile_pub_${AI}`, JSON.stringify({ data: profileFor('legacy'), cachedAt: Date.now() }));
    localStorage.setItem('welile_session_cache', 'kept');

    expect(readTrustProfileCache('agent-2', AI, false)).toBeNull();
    expect(trustKeys()).toEqual([]);
    expect(localStorage.getItem('welile_session_cache')).toBe('kept');
  });

  it("returns the viewer's own recent copy; an expired or unreadable copy is dropped", () => {
    const t0 = 1_000_000;
    writeTrustProfileCache('u-1', AI, false, profileFor('u-1'), t0);
    expect(readTrustProfileCache<TrustProfile>('u-1', AI, false, t0 + 1000)?.identity.full_name).toBe('Seen by u-1');
    expect(readTrustProfileCache('u-1', AI, false, t0 + TRUST_PROFILE_CACHE_TTL_MS)).toBeNull();
    expect(trustKeys()).toEqual([]);
    localStorage.setItem(trustProfileCacheKey('u-1', AI, false), '{not json');
    expect(readTrustProfileCache('u-1', AI, false)).toBeNull();
    expect(trustKeys()).toEqual([]);
  });

  it("sign-out (clearSessionCache) drops signed-in viewers' and unowned copies, keeps the signed-out ones", () => {
    writeTrustProfileCache('staff-1', AI, false, profileFor('staff-1'));
    writeTrustProfileCache('staff-1', 'WEL-DEF456', true, profileFor('staff-1'));
    writeTrustProfileCache(null, AI, true, profileFor('anon'));
    localStorage.setItem(`welile_trust_profile_${AI}`, '{}');
    clearSessionCache();
    expect(trustKeys()).toEqual(['welile_trust_profile_anon:pub_WEL-ABC123']);
    clearTrustProfileCaches({ includeAnonymous: true });
    expect(trustKeys()).toEqual([]);
  });
});

describe('useTrustProfile (B1)', () => {
  it("files the answer under the viewer whose session asked, and the next viewer never sees it", async () => {
    mocks.viewer = 'staff-1';
    mocks.rpc.mockResolvedValue({ data: profileFor('staff-1'), error: null });
    const first = renderHook(() => useTrustProfile(AI));
    await waitFor(() => expect(first.result.current.profile?.identity.full_name).toBe('Seen by staff-1'));
    expect(trustKeys()).toEqual(['welile_trust_profile_staff-1:WEL-ABC123']);
    first.unmount();

    // Same device, next person: the RPC is slow; staff-1's copy must not be shown meanwhile.
    mocks.viewer = 'agent-2';
    let answer!: (v: unknown) => void;
    mocks.rpc.mockReturnValue(new Promise((r) => { answer = r; }));
    const second = renderHook(() => useTrustProfile(AI));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    expect(second.result.current.profile).toBeNull();
    expect(trustKeys()).toEqual([]);
    await act(async () => { answer({ data: profileFor('agent-2'), error: null }); });
    await waitFor(() => expect(second.result.current.profile?.identity.full_name).toBe('Seen by agent-2'));
    expect(trustKeys()).toEqual(['welile_trust_profile_agent-2:WEL-ABC123']);
  });

  it("shows the viewer's own cached copy at once, and drops an old unowned copy", async () => {
    mocks.viewer = 'u-1';
    writeTrustProfileCache('u-1', AI, true, profileFor('u-1 (cached)'));
    localStorage.setItem(`welile_trust_profile_pub_${AI}`, JSON.stringify({ data: profileFor('legacy'), cachedAt: Date.now() }));
    mocks.rpc.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useTrustProfile(AI, { publicMode: true }));
    await waitFor(() => expect(result.current.profile?.identity.full_name).toBe('Seen by u-1 (cached)'));
    expect(mocks.rpc).toHaveBeenCalledWith('get_public_trust_profile', { p_ai_id: AI });
    expect(trustKeys()).toEqual(['welile_trust_profile_u-1:pub_WEL-ABC123']);
  });

  it('a change of viewer while the screen is open clears the profile, drops the answer in flight and loads again', async () => {
    mocks.viewer = 'staff-1';
    let staffAnswer!: (v: unknown) => void;
    mocks.rpc.mockReturnValueOnce(new Promise((r) => { staffAnswer = r; }));
    const { result } = renderHook(() => useTrustProfile(AI));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));

    mocks.viewer = null;
    mocks.rpc.mockResolvedValueOnce({ data: profileFor('anon'), error: null });
    act(() => { for (const cb of mocks.authCallbacks) cb('SIGNED_OUT', null); });
    await act(async () => { staffAnswer({ data: profileFor('staff-1'), error: null }); });
    await waitFor(() => expect(result.current.profile?.identity.full_name).toBe('Seen by anon'));
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(trustKeys()).toEqual(['welile_trust_profile_anon:WEL-ABC123']);
  });

  it('the same viewer refreshing a token does not reload', async () => {
    mocks.viewer = 'u-1';
    mocks.rpc.mockResolvedValue({ data: profileFor('u-1'), error: null });
    const { result, unmount } = renderHook(() => useTrustProfile(AI));
    await waitFor(() => expect(result.current.profile).not.toBeNull());
    act(() => { for (const cb of mocks.authCallbacks) cb('TOKEN_REFRESHED', { user: { id: 'u-1' } }); });
    await new Promise((r) => setTimeout(r, 5));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(result.current.profile?.identity.full_name).toBe('Seen by u-1');
    unmount();
    expect(mocks.unsubscribe).toHaveBeenCalled();
  });
});

describe('rent-facilitation reward at a rate (B2)', () => {
  it('no rate, no figure', () => {
    expect(calculateSupporterRewardAt(1_000_000, null)).toBeNull();
    expect(sumSupporterRewardsAt([100_000, 200_000], null)).toBeNull();
    expect(calculateSupporterRewardAt(Number.NaN, 10)).toBeNull();
    expect(calculateSupporterRewardAt(-1, 10)).toBeNull();
  });

  it("prices at the person's rate, rounded as the database pays it", () => {
    expect(calculateSupporterRewardAt(1_000_000, 10)).toBe(100_000);
    expect(calculateSupporterRewardAt('250000', 20)).toBe(50_000);
    expect(calculateSupporterRewardAt(333_333, 10)).toBe(33_333);
  });

  it('switch off (rate 15): the same figure the deprecated helper shows for every whole rent', () => {
    for (let rent = 0; rent <= 200_000; rent += 7) {
      expect(calculateSupporterRewardAt(rent, 15)).toBe(calculateSupporterReward(rent));
    }
    for (const rent of [450_000, 1_234_567, 9_999_999, 10_000_010]) {
      expect(calculateSupporterRewardAt(rent, 15)).toBe(calculateSupporterReward(rent));
    }
  });

  it('a total rounds each request on its own (equal to the old running total at 15)', () => {
    const rents = [100_010, 100_030, 99_990, 250_003];
    expect(sumSupporterRewardsAt(rents, 15)).toBe(rents.reduce((a, r) => a + calculateSupporterReward(r), 0));
    expect(sumSupporterRewardsAt(rents, 10)).toBe(rents.reduce((a, r) => a + (calculateSupporterRewardAt(r, 10) ?? 0), 0));
    expect(sumSupporterRewardsAt([100_000, null, 'x'], 10)).toBe(10_000);
    expect(sumSupporterRewardsAt([], 10)).toBe(0);
  });
});

describe('masked trust figures are unknown, never 0 (B3)', () => {
  it('formats an unknown figure as a dash, a known one as formatUGX does', () => {
    expect(formatUGXOrDash(null)).toBe('—');
    expect(formatUGXOrDash(undefined)).toBe('—');
    expect(formatUGXOrDash(Number.NaN)).toBe('—');
    expect(formatUGXOrDash(0)).toBe(formatUGX(0));
    expect(formatUGXOrDash(1_050_000)).toBe(formatUGX(1_050_000));
    expect(formatUGX(null as unknown as number)).toBe(formatUGX(0)); // why screens need the dash helper
  });

  it('states the vouch limit only when it is a known positive amount', () => {
    expect(shownVouchLimit(profileFor('x', 1_050_000))).toBe(1_050_000);
    expect(shownVouchLimit(profileFor('x', null))).toBeNull();
    expect(shownVouchLimit(profileFor('x', 0))).toBeNull();
    expect(buildWhatsAppMessage(profileFor('x', 1_050_000))).toMatch(/Vouches Up To/);
    const masked = buildWhatsAppMessage(profileFor('x', null));
    expect(masked).not.toMatch(/Vouches Up To/);
    expect(masked).not.toMatch(/\b0\b/);
  });
});

describe('note activation: contact mismatch (B4)', () => {
  it('always tells the person Partner Ops can link the note, whatever the server says', () => {
    const msg = 'This note was written for another phone number or email. Partner Ops can link it for you.';
    expect(activationErrorFrom(403, { error: 'Contact does not match.', code: 'NOTE_CONTACT_MISMATCH' })).toEqual({ status: 403, kind: 'contact_mismatch', message: msg });
    expect(activationErrorFrom(403, { error: msg })).toMatchObject({ kind: 'contact_mismatch', message: msg });
    // Other refusals keep the server's own text.
    expect(activationErrorFrom(403, { error: 'This note is already linked to another account', code: 'NOTE_LINKED_ELSEWHERE' }).message)
      .toBe('This note is already linked to another account');
  });
});
