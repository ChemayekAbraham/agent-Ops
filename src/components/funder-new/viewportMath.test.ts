import { describe, expect, it } from 'vitest';
import { viewportFromCenter } from './viewportMath';

describe('viewportFromCenter', () => {
  it('spans the whole world at zoom 0 in a 256 px wide map', () => {
    const v = viewportFromCenter({ lat: 0, lng: 0 }, 0, 256, 256);
    expect(v.minLng).toBeCloseTo(-180, 5);
    expect(v.maxLng).toBeCloseTo(180, 5);
    expect(v.zoom).toBe(0);
  });

  it('halves the longitude span for each zoom step', () => {
    const z1 = viewportFromCenter({ lat: 0, lng: 0 }, 1, 256, 256);
    expect(z1.maxLng - z1.minLng).toBeCloseTo(180, 5);
    const z2 = viewportFromCenter({ lat: 0, lng: 0 }, 2, 256, 256);
    expect(z2.maxLng - z2.minLng).toBeCloseTo(90, 5);
  });

  it('is centred on the given point and ordered south to north, west to east', () => {
    const v = viewportFromCenter({ lat: 0.3476, lng: 32.5825 }, 12, 700, 770);
    expect(v.minLat).toBeLessThan(0.3476);
    expect(v.maxLat).toBeGreaterThan(0.3476);
    expect(v.minLng).toBeLessThan(32.5825);
    expect(v.maxLng).toBeGreaterThan(32.5825);
    expect((v.minLng + v.maxLng) / 2).toBeCloseTo(32.5825, 6);
  });

  it('matches the area Google Maps reported for the Kampala view (700 x 773 px, zoom 12)', () => {
    // Longitude span at zoom 12 is width / (256 * 2^12 / 360) degrees.
    const v = viewportFromCenter({ lat: 0.3476, lng: 32.5825 }, 12, 700, 773);
    expect(v.maxLng - v.minLng).toBeCloseTo((700 / (256 * 2 ** 12)) * 360, 6);
    // Near the equator a degree of latitude is about the same height as a degree of longitude.
    expect(v.maxLat - v.minLat).toBeCloseTo(((773 / (256 * 2 ** 12)) * 360), 3);
  });

  it('reports a radius that grows with the map and is never below 1 km', () => {
    const small = viewportFromCenter({ lat: 0.3, lng: 32.5 }, 18, 300, 300);
    const large = viewportFromCenter({ lat: 0.3, lng: 32.5 }, 10, 700, 770);
    expect(small.radiusKm).toBeGreaterThanOrEqual(1);
    expect(large.radiusKm).toBeGreaterThan(small.radiusKm);
  });
});
