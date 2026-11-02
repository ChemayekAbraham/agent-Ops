import { describe, expect, it } from 'vitest';
import { coarsenMapCells } from './coarsenMapCells';
import type { FunderNewMapCell } from './FunderNewRouteMap';

const cell = (key: string, lat: number, lng: number, count: number, amount: number, house: FunderNewMapCell['house'] = null): FunderNewMapCell => ({
  key,
  lat,
  lng,
  count,
  amount,
  house,
});

describe('coarsenMapCells', () => {
  it('leaves street level cells alone so single houses stay tappable', () => {
    const cells = [cell('a', 0.3, 32.5, 1, 100_000), cell('b', 0.3001, 32.5001, 1, 120_000)];
    expect(coarsenMapCells(cells, 15)).toBe(cells);
    expect(coarsenMapCells(cells, 17)).toBe(cells);
  });

  it('merges neighbouring cells at city zoom and keeps the totals', () => {
    // Two server cells (pitch 360/2^15) inside one merged cell (pitch 360/2^14), plus one far away.
    const serverPitch = 360 / 2 ** 15;
    const cells = [
      cell('a', serverPitch * 100 + 0.0001, serverPitch * 200 + 0.0001, 3, 150_000),
      cell('b', serverPitch * 100 + 0.0002, serverPitch * 201 - 0.0001, 5, 90_000),
      cell('far', 1.2, 33.4, 2, 200_000),
    ];
    const out = coarsenMapCells(cells, 12);
    expect(out.length).toBeLessThan(cells.length);
    expect(out.reduce((sum, c) => sum + c.count, 0)).toBe(10);
    const merged = out.find((c) => c.count === 8)!;
    expect(merged.amount).toBe(90_000);
    expect(merged.house).toBeNull();
    expect(out.find((c) => c.key === 'far')).toBeDefined();
  });

  it('returns an untouched cell as it came from the server', () => {
    const only = cell('solo', 0.31, 32.51, 1, 80_000, { house_id: 'h1' } as FunderNewMapCell['house']);
    const other = cell('other', 1.5, 33.5, 4, 70_000);
    const out = coarsenMapCells([only, other], 12);
    expect(out).toContain(only);
  });

  it('ignores a missing rent when picking the lowest', () => {
    const serverPitch = 360 / 2 ** 15;
    const out = coarsenMapCells(
      [
        cell('a', serverPitch * 10 + 0.0001, serverPitch * 20 + 0.0001, 1, 0),
        cell('b', serverPitch * 10 + 0.0002, serverPitch * 21 - 0.0001, 1, 110_000),
      ],
      12,
    );
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(110_000);
    expect(out[0].count).toBe(2);
  });
});
