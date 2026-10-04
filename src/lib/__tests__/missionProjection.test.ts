import { describe, it, expect } from 'vitest';
import {
  buildRentEstimator,
  projectAnnualReceivable,
  projectFullPotential,
  ANNUAL_PROJECTION_MARKUP,
  type ProjectableHouse,
} from '@/lib/missionProjection';

/**
 * Regression: empty-house projections must NEVER collapse to UGX 0 across
 * the All time / 30 day / 7 day / 2 day filters when the platform has at
 * least one priced house to learn an average from.
 *
 * Each "window" is modelled by the set of houses loaded for that window plus
 * the platform-wide (window-independent) average rent.
 */

const GLOBAL_AVG = 485_429; // platform-wide avg known monthly rent (UGX)

// Houses with no recorded rent — what the agent sees in narrow windows.
const UNPRICED: ProjectableHouse[] = [
  { monthly_rent: null, number_of_rooms: null },
  { monthly_rent: 0, number_of_rooms: 2 },
  { monthly_rent: null, number_of_rooms: 3 },
];

// Houses with recorded rent — present in wider windows.
const PRICED: ProjectableHouse[] = [
  { monthly_rent: 600_000, number_of_rooms: 2 },
  { monthly_rent: 400_000, number_of_rooms: 1 },
];

// Each scenario mirrors a real filter selection.
const WINDOWS: Array<{ label: string; houses: ProjectableHouse[] }> = [
  { label: 'All time', houses: [...PRICED, ...UNPRICED] },
  { label: '30 days', houses: [...PRICED, ...UNPRICED] },
  { label: '7 days', houses: [...UNPRICED] }, // narrow window: no priced houses loaded
  { label: '2 days', houses: [...UNPRICED] }, // narrow window: no priced houses loaded
];

describe('mission projection — per-house estimate never collapses to 0', () => {
  for (const { label, houses } of WINDOWS) {
    it(`[${label}] estimates a positive monthly rent for every unpriced house`, () => {
      const est = buildRentEstimator(houses, GLOBAL_AVG);
      for (const h of UNPRICED) {
        expect(est.estimateFor(h)).toBeGreaterThan(0);
      }
    });

    it(`[${label}] keeps the overall average positive via the global fallback`, () => {
      const est = buildRentEstimator(houses, GLOBAL_AVG);
      expect(est.avgOverall).toBeGreaterThan(0);
    });
  }
});

describe('mission projection — "Est. full potential" never collapses to 0', () => {
  for (const { label } of WINDOWS) {
    it(`[${label}] projects a positive total when there are unpriced houses`, () => {
      // Narrow windows have no priced houses, so knownTotal = 0,
      // but the global avg must still drive a positive projection.
      const total = projectFullPotential({
        knownTotal: 0,
        missingCount: 9,
        avgKnownMonthly: GLOBAL_AVG,
      });
      expect(total).toBeGreaterThan(0);
    });
  }

  it('matches the RPC formula (avg * 1.33 * 12 per missing house)', () => {
    const total = projectFullPotential({
      knownTotal: 0,
      missingCount: 9,
      avgKnownMonthly: GLOBAL_AVG,
    });
    expect(total).toBeCloseTo(9 * GLOBAL_AVG * ANNUAL_PROJECTION_MARKUP * 12, 2);
  });
});

describe('mission projection — guards', () => {
  it('returns 0 only when there is genuinely no data to learn from', () => {
    const est = buildRentEstimator(UNPRICED, 0);
    expect(est.avgOverall).toBe(0);
    expect(est.estimateFor(UNPRICED[0])).toBe(0);
    expect(
      projectFullPotential({ knownTotal: 0, missingCount: 9, avgKnownMonthly: 0 }),
    ).toBe(0);
  });

  it('projectAnnualReceivable ignores non-positive rents', () => {
    expect(projectAnnualReceivable(0)).toBe(0);
    expect(projectAnnualReceivable(-100)).toBe(0);
    expect(projectAnnualReceivable(100_000)).toBeCloseTo(100_000 * 1.33 * 12, 2);
  });

  it('scales by room count when per-room data is available', () => {
    const est = buildRentEstimator(PRICED, GLOBAL_AVG);
    expect(est.avgPerRoom).toBeGreaterThan(0);
    const oneRoom = est.estimateFor({ monthly_rent: null, number_of_rooms: 1 });
    const threeRoom = est.estimateFor({ monthly_rent: null, number_of_rooms: 3 });
    expect(threeRoom).toBeGreaterThan(oneRoom);
  });
});

/**
 * Edge-case regression: dirty/real-world house rows must not poison the
 * average or drag any window's projection down to UGX 0.
 */
describe('mission projection — dirty data never collapses projections to 0', () => {
  // Houses with completely absent rent/room fields (undefined props).
  const MISSING_FIELDS = [
    {}, // no fields at all
    { number_of_rooms: 2 }, // rooms but no rent
    { monthly_rent: undefined, number_of_rooms: undefined },
  ] as unknown as ProjectableHouse[];

  // Malformed amounts: strings, junk, NaN, Infinity.
  const MALFORMED = [
    { monthly_rent: '600000', number_of_rooms: 2 }, // numeric string
    { monthly_rent: 'not-a-number', number_of_rooms: 1 }, // junk
    { monthly_rent: NaN, number_of_rooms: 1 },
    { monthly_rent: Infinity, number_of_rooms: 1 },
    { monthly_rent: '450,000', number_of_rooms: 1 }, // comma-formatted string
  ] as unknown as ProjectableHouse[];

  // Mixed UGX directions: negative/zero credits mixed with positive rents.
  const MIXED_DIRECTIONS = [
    { monthly_rent: 600_000, number_of_rooms: 2 },
    { monthly_rent: -600_000, number_of_rooms: 2 }, // reversal/credit
    { monthly_rent: 0, number_of_rooms: 1 },
    { monthly_rent: -1, number_of_rooms: 1 },
    { monthly_rent: 400_000, number_of_rooms: 1 },
  ] as unknown as ProjectableHouse[];

  it('ignores houses with missing rent fields and falls back to the global avg', () => {
    const est = buildRentEstimator(MISSING_FIELDS, GLOBAL_AVG);
    // No usable rents → in-window avg falls back to the platform-wide avg.
    expect(est.knownCount).toBe(0);
    expect(est.avgOverall).toBe(GLOBAL_AVG);
    for (const h of MISSING_FIELDS) {
      expect(est.estimateFor(h)).toBeGreaterThan(0);
    }
  });

  it('coerces well-formed numeric strings but discards junk/NaN/Infinity', () => {
    const est = buildRentEstimator(MALFORMED, GLOBAL_AVG);
    // Only the "600000" string is a valid finite positive number.
    expect(est.knownCount).toBe(1);
    expect(est.avgOverall).toBe(600_000);
    expect(est.estimateFor({ monthly_rent: null, number_of_rooms: 1 })).toBeGreaterThan(0);
  });

  it('never feeds non-finite amounts into the annual projection', () => {
    expect(projectAnnualReceivable(NaN as unknown as number)).toBe(0);
    expect(projectAnnualReceivable(Infinity as unknown as number)).toBe(0);
    expect(projectAnnualReceivable('not-a-number' as unknown as number)).toBe(0);
  });

  it('drops negative/zero (mixed-direction) rents from the learned average', () => {
    const est = buildRentEstimator(MIXED_DIRECTIONS, GLOBAL_AVG);
    // Only the two positive rents (600k, 400k) count → avg 500k.
    expect(est.knownCount).toBe(2);
    expect(est.avgOverall).toBe(500_000);
    expect(est.estimateFor({ monthly_rent: null, number_of_rooms: 2 })).toBeGreaterThan(0);
  });

  it('projects a positive full potential even when every priced row is dirty', () => {
    // No clean priced rows in-window → knownTotal 0, but global avg drives it.
    const total = projectFullPotential({
      knownTotal: 0,
      missingCount: 9,
      avgKnownMonthly: GLOBAL_AVG,
    });
    expect(total).toBeGreaterThan(0);
  });

  it('treats a malformed/negative avg as no-signal (not a negative projection)', () => {
    expect(
      projectFullPotential({ knownTotal: 0, missingCount: 9, avgKnownMonthly: -500_000 }),
    ).toBe(0);
    expect(
      projectFullPotential({
        knownTotal: 0,
        missingCount: 9,
        avgKnownMonthly: NaN as unknown as number,
      }),
    ).toBe(0);
  });
});
