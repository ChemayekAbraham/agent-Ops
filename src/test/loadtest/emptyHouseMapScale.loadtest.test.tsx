/**
 * Load tests for the empty-house map at African scale.
 *
 * The catalogue simulated here holds well over 10,000,000 empty houses. The map
 * must stay bounded and responsive: every viewport query returns at most 400
 * grid cells, scans at most 20,000 rows, small pans reuse the cache instead of
 * refetching, and cluster interactions keep drilling down to single houses.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import {
  AFRICA_BOUNDS,
  SERVER_CELL_LIMIT,
  SERVER_SCAN_CAP,
  catalogueSize,
  cellSizeForZoom,
  queryCatalogue,
} from './africaHouseCatalogue';
import {
  clusterMarkerLabel,
  clusterMarkerSize,
  clusterZoomTarget,
} from '@/components/partner/emptyHouseMapCluster';

const rpcCalls: Array<Record<string, unknown>> = [];

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(async (_fn: string, args: Record<string, unknown>) => {
      rpcCalls.push(args);
      return {
        data: queryCatalogue({
          minLat: Number(args.p_min_lat),
          minLng: Number(args.p_min_lng),
          maxLat: Number(args.p_max_lat),
          maxLng: Number(args.p_max_lng),
          zoom: Number(args.p_zoom),
          search: (args.p_search as string | null) ?? null,
          district: (args.p_district as string | null) ?? null,
          minRent: (args.p_min_rent as number | null) ?? null,
          maxRent: (args.p_max_rent as number | null) ?? null,
          limit: Number(args.p_limit ?? SERVER_CELL_LIMIT),
        }),
        error: null,
      };
    }),
  },
}));

// Imported after the mock so the hook picks up the stubbed client.
const { useEmptyHouseMapCells } = await import('@/hooks/useEmptyHouseMapCells');

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const CONTINENT = { ...AFRICA_BOUNDS, zoom: 4 };

const KAMPALA = { minLat: 0.2, maxLat: 0.45, minLng: 32.5, maxLng: 32.75, zoom: 12 };

beforeEach(() => {
  rpcCalls.length = 0;
});

describe('empty-house map at 10,000,000+ house scale', () => {
  it('simulates a catalogue larger than 10 million houses', () => {
    expect(catalogueSize()).toBeGreaterThan(10_000_000);
  });

  it('returns a bounded payload for a whole-continent viewport', async () => {
    const started = performance.now();
    const payload = queryCatalogue(CONTINENT);
    const elapsed = performance.now() - started;

    expect(payload.cells.length).toBeLessThanOrEqual(SERVER_CELL_LIMIT);
    expect(payload.scanned).toBeLessThanOrEqual(SERVER_SCAN_CAP);
    expect(payload.scan_capped).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('stays bounded and fast at every zoom level across Africa', () => {
    for (let zoom = 3; zoom <= 18; zoom += 1) {
      const span = 180 / Math.pow(2, zoom);
      const query = {
        minLat: 0.3 - span,
        maxLat: 0.3 + span,
        minLng: 32.6 - span,
        maxLng: 32.6 + span,
        zoom,
      };
      const started = performance.now();
      const payload = queryCatalogue(query);
      const elapsed = performance.now() - started;

      expect(payload.cells.length).toBeLessThanOrEqual(SERVER_CELL_LIMIT);
      expect(payload.scanned).toBeLessThanOrEqual(SERVER_SCAN_CAP);
      expect(payload.cell_size).toBeCloseTo(cellSizeForZoom(zoom), 10);
      expect(elapsed).toBeLessThan(500);
    }
  });

  it('keeps a 40-step pan and zoom journey responsive', async () => {
    const { result, rerender } = renderHook(
      ({ viewport }: { viewport: typeof KAMPALA }) => useEmptyHouseMapCells(viewport, {}, true),
      { wrapper, initialProps: { viewport: KAMPALA } },
    );

    await waitFor(() => expect(result.current.data).toBeTruthy());

    const started = performance.now();
    for (let step = 1; step <= 40; step += 1) {
      const drift = step * 0.35;
      const zoom = 8 + (step % 9);
      rerender({
        viewport: {
          minLat: KAMPALA.minLat + drift,
          maxLat: KAMPALA.maxLat + drift,
          minLng: KAMPALA.minLng + drift,
          maxLng: KAMPALA.maxLng + drift,
          zoom,
        },
      });
      await waitFor(() => expect(result.current.isFetching).toBe(false));
      expect(result.current.data!.cells.length).toBeLessThanOrEqual(SERVER_CELL_LIMIT);
    }
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(15_000);
    expect(rpcCalls.length).toBeLessThanOrEqual(41);
    expect(rpcCalls.every((call) => Number(call.p_limit) <= SERVER_CELL_LIMIT)).toBe(true);
  });

  it('reuses the cache for pans smaller than the quantisation step', async () => {
    const { result, rerender } = renderHook(
      ({ viewport }: { viewport: typeof KAMPALA }) => useEmptyHouseMapCells(viewport, {}, true),
      { wrapper, initialProps: { viewport: KAMPALA } },
    );
    await waitFor(() => expect(result.current.data).toBeTruthy());
    const afterFirst = rpcCalls.length;

    for (const nudge of [0.000001, 0.000002, 0.000003]) {
      rerender({
        viewport: {
          minLat: KAMPALA.minLat + nudge,
          maxLat: KAMPALA.maxLat + nudge,
          minLng: KAMPALA.minLng + nudge,
          maxLng: KAMPALA.maxLng + nudge,
          zoom: KAMPALA.zoom,
        },
      });
      await waitFor(() => expect(result.current.isFetching).toBe(false));
    }

    expect(rpcCalls.length).toBe(afterFirst);
  });

  it('drills clusters down to individual houses when a funder zooms in', () => {
    let zoom = 5;
    let query = {
      minLat: -5,
      maxLat: 5,
      minLng: 28,
      maxLng: 38,
      zoom,
    };
    let payload = queryCatalogue(query);
    expect(payload.cells.some((cell) => cell.count > 1)).toBe(true);

    for (let hop = 0; hop < 4; hop += 1) {
      const biggest = payload.cells.reduce((a, b) => (b.count > a.count ? b : a));
      expect(clusterMarkerSize(biggest.count)).toBeGreaterThanOrEqual(42);
      expect(clusterMarkerLabel(biggest.count)).toMatch(/^[\d,]+(k\+)?$/);

      zoom = clusterZoomTarget(zoom);
      const span = 180 / Math.pow(2, zoom);
      query = {
        minLat: biggest.latitude - span,
        maxLat: biggest.latitude + span,
        minLng: biggest.longitude - span,
        maxLng: biggest.longitude + span,
        zoom,
      };
      payload = queryCatalogue(query);
      expect(payload.cells.length).toBeLessThanOrEqual(SERVER_CELL_LIMIT);
    }

    expect(zoom).toBe(17);
    expect(payload.cells.some((cell) => cell.count === 1 && cell.house)).toBe(true);
  });

  it('applies rent, district and search filters inside the bounded query', () => {
    const filtered = queryCatalogue({
      ...CONTINENT,
      minRent: 400_000,
      maxRent: 900_000,
      district: 'Kampala',
      search: 'Kampala',
    });
    expect(filtered.cells.length).toBeLessThanOrEqual(SERVER_CELL_LIMIT);
    for (const cell of filtered.cells) {
      expect(cell.min_rent).toBeGreaterThanOrEqual(400_000);
      expect(cell.max_rent).toBeLessThanOrEqual(900_000);
      if (cell.house) expect(cell.house.district).toBe('Kampala');
    }
  });

  it('labels very large clusters compactly', () => {
    expect(clusterMarkerLabel(12_400)).toBe('12k+');
    expect(clusterMarkerSize(12_400)).toBe(58);
    expect(clusterMarkerLabel(240)).toBe('240');
    expect(clusterZoomTarget(17)).toBe(18);
  });
});
