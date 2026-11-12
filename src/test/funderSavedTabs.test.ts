import { describe, expect, it } from 'vitest';
import type { CoSupportInvite } from '@/lib/coSupport';
import {
  coSupportTabRows,
  defaultFunderSavedTab,
  floatHoldBreakdown,
  floatHoldLine,
  floatShortHoldHint,
  funderSavedCounts,
  funderSavedTotal,
} from '@/lib/funderSavedTabs';

const NOW = Date.parse('2026-11-12T11:35:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function invite(over: Partial<CoSupportInvite>): CoSupportInvite {
  return {
    id: 'i1', kind: 'rent_plan', code: 'ABCDEFGHJKLM', status: 'open', expires_at: iso(NOW + 26 * H),
    rent_request_id: 'r1', house_id: null, house_title: null, awaiting_partner_ops: false,
    tenant_first_name: 'Odenyo', city: 'Kampala', house_image_url: null, rent_amount: 700_000,
    plan_amount: 714_000, your_role: 'lead', your_share: 357_000, partner_share: 357_000,
    partner_first_name: null, your_monthly_rent_profit_share: null, your_portfolio_id: null,
    accepted_at: null, created_at: iso(NOW - 22 * H), ...over,
  };
}

describe('Saved Items tabs', () => {
  it('lists open invites first (soonest to end on top), drops closed ones older than a week and other people\'s', () => {
    const rows = coSupportTabRows([
      invite({ id: 'old-closed', status: 'cancelled', created_at: iso(NOW - 8 * 24 * H) }),
      invite({ id: 'recent-closed', status: 'expired', created_at: iso(NOW - 2 * 24 * H) }),
      invite({ id: 'open-later', expires_at: iso(NOW + 40 * H) }),
      invite({ id: 'open-soon', expires_at: iso(NOW + 2 * H), your_role: 'invitee' }),
      invite({ id: 'not-mine', your_role: 'other' }),
      invite({ id: 'house-waiting', kind: 'house', status: 'completed', awaiting_partner_ops: true }),
    ], NOW);
    expect(rows.map((r) => r.id)).toEqual(['open-soon', 'house-waiting', 'open-later', 'recent-closed']);
  });

  it('counts live invites, bookmarks and held bookings, and opens the first non-empty pill', () => {
    const counts = funderSavedCounts({
      invites: [invite({}), invite({ id: 'gone', status: 'open', expires_at: iso(NOW - H) })],
      bookmarked: 3, bookedHeld: 1, now: NOW,
    });
    expect(counts).toEqual({ co_support: 1, bookmarked: 3, booked: 1 });
    expect(funderSavedTotal(counts)).toBe(5);
    expect(defaultFunderSavedTab(counts)).toBe('co_support');
    expect(defaultFunderSavedTab({ co_support: 0, bookmarked: 0, booked: 2 })).toBe('booked');
    expect(defaultFunderSavedTab({ co_support: 0, bookmarked: 0, booked: 0 })).toBe('bookmarked');
    expect(defaultFunderSavedTab(counts, 'booked')).toBe('booked');
  });
});

describe('float hold breakdown', () => {
  it('explains the 194,486 the owner saw: 551,486 float minus a 357,000 co-support hold', () => {
    const b = floatHoldBreakdown({ floatBalance: 551_486, available: 194_486, invites: [invite({})], now: NOW });
    expect(b).toMatchObject({ held: 357_000, coSupportHeld: 357_000, otherHeld: 0, nextReleaseAt: iso(NOW + 26 * H) });
    expect(b.shares).toEqual([{ id: 'i1', title: "Odenyo's Rent Plan", held: 357_000, expiresAt: iso(NOW + 26 * H) }]);
    expect(floatHoldLine(b)).toBe(
      "UGX 357,000 is held for your co-support of Odenyo's Rent Plan until your partner joins or the link ends on 13 Nov, 16:35.",
    );
    expect(floatShortHoldHint(b)).toContain('UGX 357,000 is held for your open co-support');
  });

  it('ignores invites I joined, expired links and closed ones; the rest of the gap is other holds', () => {
    const b = floatHoldBreakdown({
      floatBalance: 500_000, available: 300_000, now: NOW,
      invites: [
        invite({ your_role: 'invitee' }),
        invite({ id: 'x', expires_at: iso(NOW - H) }),
        invite({ id: 'y', status: 'completed' }),
      ],
    });
    expect(b).toMatchObject({ held: 200_000, coSupportHeld: 0, otherHeld: 200_000, shares: [] });
    expect(floatHoldLine(b)).toBe('UGX 200,000 is held for supports still being processed.');
    expect(floatShortHoldHint(b)).toBe('');
  });

  it('never reports more co-support hold than the gap, and nothing when nothing is held', () => {
    const capped = floatHoldBreakdown({ floatBalance: 100_000, available: 0, invites: [invite({})], now: NOW });
    expect(capped).toMatchObject({ held: 100_000, coSupportHeld: 100_000, otherHeld: 0 });
    const none = floatHoldBreakdown({ floatBalance: 449_486, available: 449_486, invites: [], now: NOW });
    expect(floatHoldLine(none)).toBeNull();
    const twoShares = floatHoldBreakdown({
      floatBalance: 800_000, available: 100_000, now: NOW,
      invites: [invite({}), invite({ id: 'h', kind: 'house', house_title: 'Ntinda 2-room', your_share: 343_000, expires_at: iso(NOW + 3 * H) })],
    });
    expect(twoShares.shares.map((s) => s.title)).toEqual(['Ntinda 2-room', "Odenyo's Rent Plan"]);
    expect(floatHoldLine(twoShares)).toBe('UGX 700,000 is held for 2 co-support invitations (the first link ends on 12 Nov, 17:35).');
  });
});
