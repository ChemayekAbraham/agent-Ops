/**
 * Partner Returns Phase 4, browser round 2 (tester's suite, beside partnerReturnsTrustCacheAndReward):
 * - the trust-profile cache never serves one viewer's copy to another viewer: signed-in A then B, signed
 *   out then signed in, and a session that cannot be read (no cache at all);
 * - calculateSupporterRewardAt / sumSupporterRewardsAt: no rate -> no figure, 10% and 15% priced;
 * - the release gate and the Deno release scan both list calculateSupporterReward, and its importers are
 *   exactly the three screens the gate names;
 * - the 4b-masked trust figures (get_user_trust_profile's mask list) are typed `number | null`, and the
 *   share text and PDF built from a fully masked profile never print "null", "NaN" or a 0 amount.
 *
 * Note on types: tsconfig.app.json has strict: false, so `number | null` collapses to `number` and tsc
 * cannot tell the two apart. The type checks below therefore read the declaration text.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type AuthCallback = (event: string, session: { user: { id: string } } | null) => void;
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  viewer: null as string | null,
  sessionThrows: false,
  authCallbacks: [] as AuthCallback[],
  pdfTexts: [] as string[],
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    auth: {
      getSession: () =>
        mocks.sessionThrows
          ? Promise.reject(new Error('storage blocked'))
          : Promise.resolve({ data: { session: mocks.viewer ? { user: { id: mocks.viewer } } : null }, error: null }),
      onAuthStateChange: (cb: AuthCallback) => {
        mocks.authCallbacks.push(cb);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  },
}));
// A recording jsPDF: every method is a no-op except text(), whose strings are kept.
vi.mock('jspdf', () => {
  class FakePdf {
    internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } };
    constructor() {
      return new Proxy(this, {
        get(target, prop) {
          if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
          if (prop === 'text') return (t: unknown) => { mocks.pdfTexts.push(Array.isArray(t) ? t.join('\n') : String(t)); };
          if (prop === 'output') return () => new Blob(['pdf']);
          if (prop === 'splitTextToSize') return (t: string) => [t];
          if (prop === 'getTextWidth') return () => 10;
          return () => {};
        },
      });
    }
  }
  return { jsPDF: FakePdf, default: FakePdf };
});

import { useTrustProfile, type TrustProfile } from '@/hooks/useTrustProfile';
import { readTrustProfileCache, trustProfileCacheKey, writeTrustProfileCache } from '@/lib/trustProfileCache';
import { clearSessionCache } from '@/lib/sessionCache';
import { calculateSupporterReward, calculateSupporterRewardAt, sumSupporterRewardsAt } from '@/lib/rentCalculations';
import { buildWhatsAppMessage, shownVouchLimit } from '@/lib/shareTrustProfile';
import { generateTrustProfilePdf } from '@/lib/trustProfilePdf';

const SRC = join(__dirname, '..');
const ROOT = join(SRC, '..');
const AI = 'WEL-ABC123';
const trustKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('welile_trust_profile_')).sort();

function profileFor(viewer: string): TrustProfile {
  return {
    ai_id: AI,
    user_id: 'subject',
    identity: {
      full_name: `Seen by ${viewer}`, phone: null, email: null, national_id: null, national_id_present: false,
      avatar_url: null, verified: true, member_since: '2025-01-01T00:00:00Z', roles: ['supporter'], primary_role: 'supporter',
    },
    trust: {
      score: 62, tier: 'standard', data_points: 6, borrowing_limit_ugx: 1_050_000,
      vouch_breakdown: {
        total_ugx: 1_050_000, portfolio_component_ugx: 800_000, angel_shares_ugx: 0, shares_component_ugx: 0, boosters_ugx: 250_000,
        booster_breakdown: { wallet_activity: 100_000, network_contribution: 50_000, agent_performance: 0, verification: 50_000, movement_behavior: 0, payment_history: 50_000 },
      },
      breakdown: { supporter: 20, payment: 10, wallet: 5, network: 2, verification: 3, behavior: 0, landlord: 0 },
      weights: { payment: 15, wallet: 10, network: 15, verification: 10, behavior: 5, landlord: 5 },
    },
    supporter_activity: {
      is_supporter: true, portfolio_value: 800_000, active_portfolios: 1, total_roi_earned: 240_000,
      roi_paid_30d: 80_000, roi_paid_180d: 240_000, roi_monthly_avg: 80_000,
    },
    payment_history: { total_rent_plans: 0, total_repaid: 0, total_owing: 0, on_time_count: 0, late_count: 0, on_time_rate: 0 },
    wallet_activity: { balance: null, total_received_180d: 0, total_sent_180d: 0, transaction_count_180d: 0 },
    cash_flow_capacity: { daily_avg: 3_000, weekly_avg: 21_000, monthly_avg: 90_000, roi_monthly: 80_000, wallet_monthly: 10_000, window_days: 90 },
    network: { referrals: 0, sub_agents: 0, tenants_onboarded: 0, portfolio_value: 800_000 },
    behavior: { visits_total_60d: 0, always_share_location: false },
    landlord_activity: { total_listings: 0, verified_listings: 0, guaranteed_rent: false },
    permissions: { is_self: false, is_staff_view: false, can_see_pii: false },
    generated_at: '2026-11-07T00:00:00Z',
  } as TrustProfile;
}

/** The 17 paths migration 4b (supabase/pending/…_phase4_masks.sql) sets to JSON null for a viewer who may
 *  not see the person's Returns. Kept in sync with the SQL by the first type test below. */
const MASKED_PATHS = [
  'supporter_activity.portfolio_value', 'supporter_activity.total_roi_earned',
  'supporter_activity.roi_paid_30d', 'supporter_activity.roi_paid_180d', 'supporter_activity.roi_monthly_avg',
  'cash_flow_capacity.roi_monthly', 'cash_flow_capacity.monthly_avg', 'cash_flow_capacity.weekly_avg',
  'cash_flow_capacity.daily_avg', 'network.portfolio_value',
  'trust.score', 'trust.borrowing_limit_ugx', 'trust.breakdown.supporter',
  'trust.vouch_breakdown.total_ugx', 'trust.vouch_breakdown.portfolio_component_ugx',
  'trust.vouch_breakdown.boosters_ugx', 'trust.vouch_breakdown.booster_breakdown.payment_history',
];

/** The profile as get_user_trust_profile returns it to a viewer who may not see the person's Returns. */
function maskedProfile(): TrustProfile {
  const p = JSON.parse(JSON.stringify(profileFor('other'))) as Record<string, unknown>;
  for (const path of MASKED_PATHS) {
    const parts = path.split('.');
    let node = p as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>;
    node[parts[parts.length - 1]] = null;
  }
  return p as unknown as TrustProfile;
}

beforeEach(() => {
  localStorage.clear();
  mocks.rpc.mockReset();
  mocks.viewer = null;
  mocks.sessionThrows = false;
  mocks.authCallbacks.length = 0;
  mocks.pdfTexts.length = 0;
});

describe('trust-profile cache: one viewer never sees another viewer\'s copy', () => {
  it('signed-in A then B, in both modes: B gets nothing and A\'s copies are gone', () => {
    writeTrustProfileCache('user-a', AI, false, profileFor('user-a'));
    writeTrustProfileCache('user-a', AI, true, profileFor('user-a'));
    expect(readTrustProfileCache('user-b', AI, false)).toBeNull();
    expect(readTrustProfileCache('user-b', AI, true)).toBeNull();
    expect(trustKeys()).toEqual([]);
  });

  it('A cannot read B\'s copy back either: the read is by owner, not by AI ID', () => {
    writeTrustProfileCache('user-b', AI, false, profileFor('user-b'));
    expect(readTrustProfileCache<TrustProfile>('user-b', AI, false)?.identity.full_name).toBe('Seen by user-b');
    expect(readTrustProfileCache('user-a', AI, false)).toBeNull();
    expect(readTrustProfileCache('user-b', AI, false)).toBeNull(); // dropped by A's read
  });

  it('signed out then signed in: the signed-in viewer never gets the anonymous copy', () => {
    writeTrustProfileCache(null, AI, true, profileFor('anon'));
    expect(readTrustProfileCache(null, AI, true)).not.toBeNull();
    expect(readTrustProfileCache('user-a', AI, true)).toBeNull();
    expect(trustKeys()).toEqual([]);
  });

  it('signed in then signed out: the anonymous viewer never gets the signed-in copy, even without a sign-out hook', () => {
    writeTrustProfileCache('staff-1', AI, true, profileFor('staff-1'));
    expect(readTrustProfileCache(null, AI, true)).toBeNull();
    expect(trustKeys()).toEqual([]);
  });

  it('a viewer id that looks like a key part cannot reach another viewer\'s entry', () => {
    writeTrustProfileCache('user-a', AI, false, profileFor('user-a'));
    // "user" + ":" … would only collide if the owner were parsed loosely; the owner is everything before the first colon.
    expect(readTrustProfileCache('user', AI, false)).toBeNull();
    expect(trustProfileCacheKey('user-a', AI, false)).not.toBe(trustProfileCacheKey('user', AI, false));
  });

  it('sign-out (clearSessionCache) leaves no signed-in copy behind for the next person', () => {
    writeTrustProfileCache('user-a', AI, false, profileFor('user-a'));
    writeTrustProfileCache('user-a', 'WEL-ZZZ999', true, profileFor('user-a'));
    clearSessionCache();
    expect(trustKeys().filter((k) => !k.startsWith('welile_trust_profile_anon:'))).toEqual([]);
  });
});

describe('useTrustProfile: viewer changes', () => {
  it('signed out then signed in on the open screen: the anonymous view is cleared and the new viewer\'s is loaded', async () => {
    mocks.viewer = null;
    mocks.rpc.mockResolvedValueOnce({ data: profileFor('anon'), error: null });
    const { result } = renderHook(() => useTrustProfile(AI, { publicMode: true }));
    await waitFor(() => expect(result.current.profile?.identity.full_name).toBe('Seen by anon'));
    expect(trustKeys()).toEqual(['welile_trust_profile_anon:pub_WEL-ABC123']);

    mocks.viewer = 'user-a';
    let answer!: (v: unknown) => void;
    mocks.rpc.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    act(() => { for (const cb of mocks.authCallbacks) cb('SIGNED_IN', { user: { id: 'user-a' } }); });
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    expect(result.current.profile).toBeNull(); // nothing from the anonymous view while user-a's loads
    expect(trustKeys()).toEqual([]); // and user-a's read dropped the anonymous copy
    await act(async () => { answer({ data: profileFor('user-a'), error: null }); });
    await waitFor(() => expect(result.current.profile?.identity.full_name).toBe('Seen by user-a'));
    expect(trustKeys()).toEqual(['welile_trust_profile_user-a:pub_WEL-ABC123']);
  });

  it('A then B on the open screen: A\'s answer arriving late is dropped, never shown to B or cached', async () => {
    mocks.viewer = 'user-a';
    let answerA!: (v: unknown) => void;
    mocks.rpc.mockReturnValueOnce(new Promise((r) => { answerA = r; }));
    const { result } = renderHook(() => useTrustProfile(AI));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));

    mocks.viewer = 'user-b';
    let answerB!: (v: unknown) => void;
    mocks.rpc.mockReturnValueOnce(new Promise((r) => { answerB = r; }));
    act(() => { for (const cb of mocks.authCallbacks) cb('SIGNED_IN', { user: { id: 'user-b' } }); });
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    await act(async () => { answerA({ data: profileFor('user-a'), error: null }); });
    expect(result.current.profile).toBeNull();
    expect(trustKeys()).toEqual([]);
    await act(async () => { answerB({ data: profileFor('user-b'), error: null }); });
    await waitFor(() => expect(result.current.profile?.identity.full_name).toBe('Seen by user-b'));
    expect(trustKeys()).toEqual(['welile_trust_profile_user-b:WEL-ABC123']);
  });

  it('a session that cannot be read: no cached copy is shown and the answer is not cached', async () => {
    writeTrustProfileCache(null, AI, false, profileFor('anon'));
    writeTrustProfileCache('user-a', AI, false, profileFor('user-a'));
    mocks.sessionThrows = true;
    mocks.rpc.mockResolvedValue({ data: profileFor('fresh'), error: null });
    const { result } = renderHook(() => useTrustProfile(AI));
    await waitFor(() => expect(result.current.profile?.identity.full_name).toBe('Seen by fresh'));
    // Only the fresh answer was ever shown; the two old copies are untouched and nothing new was written.
    expect(trustKeys()).toEqual(['welile_trust_profile_anon:WEL-ABC123', 'welile_trust_profile_user-a:WEL-ABC123']);
  });
});

describe('calculateSupporterRewardAt', () => {
  it('no rate (or a rate the policy rejects) gives no figure, never a default 15%', () => {
    for (const rate of [null, 0, -5, 101, Number.NaN] as (number | null)[]) {
      expect(calculateSupporterRewardAt(500_000, rate)).toBeNull();
      expect(sumSupporterRewardsAt([500_000], rate)).toBeNull();
    }
    expect(calculateSupporterRewardAt(null, 10)).toBeNull();
    expect(calculateSupporterRewardAt(undefined, 10)).toBeNull();
  });

  it('a new partner at 10%', () => {
    expect(calculateSupporterRewardAt(500_000, 10)).toBe(50_000);
    expect(calculateSupporterRewardAt(123_455, 10)).toBe(12_346); // round half up, as the database
    expect(calculateSupporterRewardAt(0, 10)).toBe(0);
    expect(sumSupporterRewardsAt([500_000, 123_455, 'not a rent'], 10)).toBe(62_346);
  });

  it('an existing partner at 15% matches today\'s helper (switch-off parity)', () => {
    expect(calculateSupporterRewardAt(500_000, 15)).toBe(75_000);
    expect(calculateSupporterRewardAt(500_000, 15)).toBe(calculateSupporterReward(500_000));
    for (const rent of [1, 3, 10, 33_333, 99_999, 100_003, 1_000_001]) {
      expect(calculateSupporterRewardAt(rent, 15)).toBe(calculateSupporterReward(rent));
    }
    expect(sumSupporterRewardsAt([3, 3], 15)).toBe(calculateSupporterReward(3) * 2); // per request, not on the total
  });

  it('an existing partner keeps a rate of their own (no cap), and staff at 20%', () => {
    expect(calculateSupporterRewardAt(500_000, 18)).toBe(90_000);
    expect(calculateSupporterRewardAt(500_000, 20)).toBe(100_000);
    expect(calculateSupporterRewardAt('500000', 12.5)).toBe(62_500);
  });
});

describe('release gate lists calculateSupporterReward', () => {
  const gate = readFileSync(join(SRC, 'test/partnerRateRelease.test.ts'), 'utf8');
  const scan = readFileSync(join(ROOT, 'supabase/functions/_shared/releaseScan_test.ts'), 'utf8');

  it('both the vitest gate and the Deno scan list it as deprecated (and not the rated helpers)', () => {
    for (const text of [gate, scan]) {
      const line = text.split(/\r?\n/).find((l) => /^\s*rentCalculations\s*:/.test(l));
      expect(line).toMatch(/['"]calculateSupporterReward['"]/);
      expect(line).not.toMatch(/calculateSupporterRewardAt|sumSupporterRewardsAt|formatUGX/);
    }
  });

  it('the gate requires the three reward screens to quote the viewer\'s own rate', () => {
    for (const f of ['components/supporter/PayLandlordDialog.tsx', 'components/supporter/RentCategoryFeed.tsx', 'pages/MyWatchlist.tsx']) {
      expect(gate).toContain(`'${f}'`);
    }
  });

  it("has no importer left: the three reward screens quote the viewer's own rate (Phase 5)", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (!['__tests__', '__snapshots__', 'tests', 'test'].includes(name)) walk(full);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) {
          const text = readFileSync(full, 'utf8');
          if (/import\s*\{[^}]*\bcalculateSupporterReward\b(?!At)[^}]*\}\s*from\s*['"][^'"]*rentCalculations['"]/.test(text)) {
            importers.push(full.slice(SRC.length + 1).split('\\').join('/'));
          }
        }
      }
    };
    walk(SRC);
    expect(importers.sort()).toEqual([]);
  }, 30_000); // reads every source file: over 5s when the whole Phase 4 set runs in parallel
});

describe('masked (null) trust figures', () => {
  const sql = readFileSync(join(ROOT, 'supabase/pending/20261108163000_partner_return_policy_phase4_masks.sql'), 'utf8');
  const types = readFileSync(join(SRC, 'hooks/useTrustProfile.ts'), 'utf8');

  /** The declared type of `field` inside the interface block that `block` opens (first match). */
  function declared(block: string | null, field: string): string | null {
    let text = types;
    if (block) {
      const at = text.search(new RegExp(`\\b${block}\\??\\s*:\\s*\\{`));
      if (at < 0) return null;
      text = text.slice(at);
    }
    const m = text.match(new RegExp(`\\n\\s*${field}\\??\\s*:\\s*([^;]+);`));
    return m ? m[1].trim() : null;
  }

  it('the test\'s mask list is the SQL\'s mask list', () => {
    const arr = sql.match(/FOREACH v_path IN ARRAY ARRAY\[([\s\S]*?)\]\s*LOOP/);
    expect(arr).not.toBeNull();
    const fromSql = [...arr![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(fromSql).toEqual([...MASKED_PATHS].sort());
  });

  it('every vouch figure 4b masks is typed number | null', () => {
    expect(declared('trust', 'borrowing_limit_ugx')).toBe('number | null');
    expect(declared('vouch_breakdown', 'total_ugx')).toBe('number | null');
    expect(declared('vouch_breakdown', 'portfolio_component_ugx')).toBe('number | null');
    expect(declared('vouch_breakdown', 'boosters_ugx')).toBe('number | null');
    expect(declared('booster_breakdown', 'payment_history')).toBe('number | null');
    expect(declared('breakdown', 'supporter')).toBe('number | null');
    expect(declared('network', 'portfolio_value')).toBe('number | null');
    for (const f of ['portfolio_value', 'total_roi_earned', 'roi_paid_30d', 'roi_paid_180d', 'roi_monthly_avg']) {
      expect(declared('supporter_activity', f), f).toBe('number | null');
    }
    for (const f of ['daily_avg', 'weekly_avg', 'monthly_avg', 'roi_monthly']) {
      expect(declared('cash_flow_capacity', f), f).toBe('number | null');
    }
  });

  // DEFECT (reported): 4b also masks trust.score (the supporter part is the score minus the visible parts),
  // but the type still says `number`, and the share text / PDF print it.
  it('trust.score, which 4b masks too, is typed number | null', () => {
    expect(declared('trust', 'score')).toBe('number | null');
  });

  it('a fully masked profile: no vouch line, and the share text prints no null, NaN or 0 amount', () => {
    const p = maskedProfile();
    expect(shownVouchLimit(p)).toBeNull();
    const msg = buildWhatsAppMessage(p);
    expect(msg).not.toMatch(/Vouches Up To/);
    expect(msg).not.toMatch(/UGX\s*0\b|USh\s*0\b/);
    expect(msg).not.toMatch(/\bnull\b|\bNaN\b|undefined/);
  });

  it('a fully masked profile: the PDF prints no null, NaN or vouch line', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    try {
      await generateTrustProfilePdf(maskedProfile());
    } finally {
      vi.unstubAllGlobals();
    }
    expect(mocks.pdfTexts.length).toBeGreaterThan(5);
    expect(mocks.pdfTexts.join('\n')).not.toMatch(/vouches up to/i);
    expect(mocks.pdfTexts.filter((t) => /\bnull\b|\bNaN\b|undefined/.test(t))).toEqual([]);
  });

  it('an unmasked profile still shows the vouch line and the score (switch-off parity)', async () => {
    const p = profileFor('self');
    expect(buildWhatsAppMessage(p)).toMatch(/Vouches Up To/);
    expect(buildWhatsAppMessage(p)).toMatch(/\(62\/100\)/);
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    try {
      await generateTrustProfilePdf(p);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(mocks.pdfTexts).toContain('62');
    expect(mocks.pdfTexts.some((t) => /vouches up to/i.test(t))).toBe(true);
  });
});
