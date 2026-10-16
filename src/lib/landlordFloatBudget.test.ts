import { describe, expect, it } from 'vitest';
import {
  fitsLandlordFloatBudget,
  landlordFloatErrorCode,
  landlordFloatErrorText,
  landlordFloatExcess,
  partitionByLandlordFloatRoom,
  summarizeCooApproval,
  type CooApprovalResult,
  type LandlordFloatPosition,
} from './landlordFloatBudget';

const period = (over: Partial<LandlordFloatPosition['daily']> = {}): LandlordFloatPosition['daily'] => ({
  budget_id: 'b', amount: 40_000_000, used: 0, misc_used: 0, approved_count: 0, remaining: 40_000_000, excess: 0,
  reason: null, over_weekly_warning: false, set_by: 'u', set_by_name: 'CFO', set_at: '2026-10-16T06:00:00Z', ...over,
});

describe('landlordFloatBudget helpers', () => {
  it('fits only a positive amount within the room, and nothing while blocked', () => {
    expect(fitsLandlordFloatBudget({ blocked: false, room: 1_000_000 }, 1_000_000)).toBe(true);
    expect(fitsLandlordFloatBudget({ blocked: false, room: 1_000_000 }, 1_000_001)).toBe(false);
    expect(fitsLandlordFloatBudget({ blocked: false, room: 1_000_000 }, 0)).toBe(false);
    expect(fitsLandlordFloatBudget({ blocked: true, room: 0 }, 1)).toBe(false);
    expect(fitsLandlordFloatBudget(undefined, 1)).toBe(false);
  });

  it('partitions in the given order, the same greedy rule the server uses', () => {
    const rows = [
      { id: 'a', rent_amount: 600 },
      { id: 'b', rent_amount: 500 }, // does not fit after a
      { id: 'c', rent_amount: 400 }, // still fits
    ];
    const { fits, overCap } = partitionByLandlordFloatRoom(rows, { blocked: false, room: 1000 });
    expect(fits.map(r => r.id)).toEqual(['a', 'c']);
    expect(overCap.map(r => r.id)).toEqual(['b']);
    expect(partitionByLandlordFloatRoom(rows, { blocked: true, room: 0 }).fits).toEqual([]);
  });

  it('reads the error code and strips it for display', () => {
    const e = new Error('NO_BUDGET: the CFO has not set today\'s landlord float budget.');
    expect(landlordFloatErrorCode(e)).toBe('NO_BUDGET');
    expect(landlordFloatErrorText(e)).toBe('the CFO has not set today\'s landlord float budget.');
    expect(landlordFloatErrorCode('OVER_WEEKLY_REASON_REQUIRED: x')).toBe('OVER_WEEKLY_REASON_REQUIRED');
    expect(landlordFloatErrorCode(new Error('something else'))).toBeNull();
    expect(landlordFloatErrorText(new Error('plain'))).toBe('plain');
  });

  it('reports an excess from either period', () => {
    expect(landlordFloatExcess({ daily: period({ excess: 200 }), weekly: period() })).toEqual({ daily: 200, weekly: 0, any: true });
    expect(landlordFloatExcess({ daily: period(), weekly: period() }).any).toBe(false);
    expect(landlordFloatExcess(undefined).any).toBe(false);
  });

  it('summarises a partial approval with the held requests and the room left', () => {
    const res: CooApprovalResult = {
      approved: [{ id: 'a', rent_amount: 1_000_000 }],
      over_cap: [{ id: 'b', rent_amount: 2_000_000, room: 500_000, misc_pending: false }],
      skipped: [],
      approved_total: 1_000_000,
      room_left: 500_000,
      status: {} as LandlordFloatPosition,
    };
    const s = summarizeCooApproval(res);
    expect(s.variant).toBe('default');
    expect(s.title).toContain('1 request approved');
    expect(s.title).toContain('UGX 1,000,000');
    expect(s.description).toContain('1 held at the COO step');
    expect(s.description).toContain('UGX 500,000');

    const none = summarizeCooApproval({ ...res, approved: [], approved_total: 0 });
    expect(none.variant).toBe('destructive');
    expect(none.title).toBe('No requests approved');
  });
});
