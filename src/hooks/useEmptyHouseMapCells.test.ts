import { describe, expect, it, vi } from 'vitest';

// Only the pure helpers are under test; keep the network and auth modules out.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/hooks/useAuthenticatedPoll', () => ({
  isUnauthenticatedRpcError: () => false,
  requireUserSession: async () => undefined,
  useAuthenticatedAudience: () => true,
}));
import {
  NEAR_BOX_DEGREES,
  mergeTileResults,
  nearBoxFor,
  type EmptyHouseMapCell,
  type EmptyHouseMapCells,
} from './useEmptyHouseMapCells';

const viewport = { minLat: 0.2, minLng: 32.4, maxLat: 0.5, maxLng: 32.8, zoom: 13 };

const cell = (key: string, count: number, lat = 0.3, lng = 32.5): EmptyHouseMapCell => ({
  key,
  count,
  latitude: lat,
  longitude: lng,
  minRent: 100_000,
  maxRent: 200_000,
  sumRent: 150_000 * count,
  district: null,
  house: null,
});

const result = (cells: EmptyHouseMapCell[], housesInView: number): EmptyHouseMapCells => ({
  cells,
  housesInView,
  scanCapped: false,
  cellSize: 0.001,
});

describe('nearBoxFor', () => {
  it('is null without a position or viewport', () => {
    expect(nearBoxFor(null, viewport)).toBeNull();
    expect(nearBoxFor({ lat: 0.3, lng: 32.5 }, null)).toBeNull();
  });

  it('is null when the person is not inside the viewport (they panned away)', () => {
    expect(nearBoxFor({ lat: 1.5, lng: 33.5 }, viewport)).toBeNull();
  });

  it('is a small box around the position, clipped to the viewport', () => {
    const box = nearBoxFor({ lat: 0.3, lng: 32.5 }, viewport)!;
    expect(box.maxLat - box.minLat).toBeCloseTo(NEAR_BOX_DEGREES * 2, 5);
    expect(box.minLat).toBeGreaterThanOrEqual(viewport.minLat);
    const edge = nearBoxFor({ lat: 0.201, lng: 32.401 }, viewport)!;
    expect(edge.minLat).toBe(viewport.minLat);
    expect(edge.minLng).toBe(viewport.minLng);
  });

  it('ignores GPS jitter so the query key stays put', () => {
    const a = nearBoxFor({ lat: 0.3001, lng: 32.5002 }, viewport);
    const b = nearBoxFor({ lat: 0.3009, lng: 32.4994 }, viewport);
    expect(a).toEqual(b);
  });
});

describe('mergeTileResults', () => {
  it('shows the near cells (and their count) before any tile has arrived', () => {
    const near = result([cell('1:1', 2), cell('1:2', 1)], 3);
    const merged = mergeTileResults([undefined, undefined, undefined, undefined], near, viewport);
    expect(merged.cells.map((c) => c.key).sort()).toEqual(['1:1', '1:2']);
    expect(merged.housesInView).toBe(3);
  });

  it('lets the full tile win over a partial near cell on the box edge', () => {
    const near = result([cell('edge', 2), cell('inner', 1)], 3);
    const tile = result([cell('edge', 5), cell('other', 4)], 9);
    const merged = mergeTileResults([tile], near, viewport);
    expect(merged.cells.find((c) => c.key === 'edge')!.count).toBe(5);
    expect(merged.cells.map((c) => c.key).sort()).toEqual(['edge', 'inner', 'other']);
  });

  it('never double counts homes: the figure comes from the tiles once they exist', () => {
    const near = result([cell('inner', 1)], 1);
    const tiles = [result([cell('a', 3)], 3), result([cell('b', 4)], 4)];
    expect(mergeTileResults(tiles, near, viewport).housesInView).toBe(7);
  });

  it('works with no near result, as before', () => {
    const merged = mergeTileResults([result([cell('a', 1)], 1), undefined], undefined, viewport);
    expect(merged.cells).toHaveLength(1);
    expect(merged.housesInView).toBe(1);
  });

  it('keeps the cells nearest the middle when over the cell budget', () => {
    const cells = [
      cell('far', 1, 0.21, 32.41),
      cell('mid1', 1, 0.35, 32.6),
      cell('mid2', 1, 0.351, 32.601),
      cell('far2', 1, 0.49, 32.79),
    ];
    const merged = mergeTileResults([result(cells, 4)], undefined, viewport, 2);
    expect(merged.cells.map((c) => c.key).sort()).toEqual(['mid1', 'mid2']);
  });
});
