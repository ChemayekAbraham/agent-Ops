import { describe, it, expect } from 'vitest';
import { LANDLORD_OPS_SECTIONS, ALL_LANDLORD_OPS_ITEMS, findLandlordOpsItem } from './landlordOpsNav';
import { LANDLORD_OPS_ROUTES } from '@/pages/landlord-ops/routes';

/**
 * The sidebar and the router are two independent lists of the same
 * destinations. Before the rebuild they drifted — nav keys pointed at views the
 * renderer could not resolve, which showed up as a blank pane rather than an
 * error. These tests make that drift a failing build instead.
 */
describe('landlordOpsNav ↔ router', () => {
  const navPaths = ALL_LANDLORD_OPS_ITEMS.map((i) => i.path).sort();
  const routePaths = LANDLORD_OPS_ROUTES.map((r) => r.path).sort();

  it('every sidebar destination has a route', () => {
    expect(navPaths).toEqual(routePaths);
  });

  it('has no duplicate paths or keys', () => {
    expect(new Set(navPaths).size).toBe(navPaths.length);
    const keys = ALL_LANDLORD_OPS_ITEMS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('exposes exactly one index (Today) destination', () => {
    expect(navPaths.filter((p) => p === '')).toHaveLength(1);
  });

  it('resolves a destination from a path, a key or a full URL', () => {
    expect(findLandlordOpsItem('verify/houses')?.label).toBe('Houses');
    expect(findLandlordOpsItem('verify-houses')?.label).toBe('Houses');
    expect(findLandlordOpsItem('/landlord-ops/verify/houses')?.label).toBe('Houses');
    expect(findLandlordOpsItem('')?.label).toBe('Today');
    expect(findLandlordOpsItem('today')?.label).toBe('Today');
  });

  it('returns nothing for an unknown destination rather than guessing', () => {
    expect(findLandlordOpsItem('verify/does-not-exist')).toBeUndefined();
  });

  it('gives every badgeKey in the nav a section it belongs to', () => {
    const withBadges = ALL_LANDLORD_OPS_ITEMS.filter((i) => i.badgeKey);
    expect(withBadges.length).toBeGreaterThan(0);
    // Badge keys are supplied by useLandlordOpsBadgeCounts.
    const supplied = new Set(['verify', 'landlords', 'lc1', 'pipeline', 'payouts']);
    for (const item of withBadges) {
      expect(supplied.has(item.badgeKey!)).toBe(true);
    }
  });

  it('keeps every section non-empty', () => {
    for (const section of LANDLORD_OPS_SECTIONS) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });
});
