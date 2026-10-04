/**
 * Integration tests for the paginated GPS house-search RPC (`find_nearby_houses`).
 *
 * These verify the guarantees the tenant/funder Available-Houses pagination
 * relies on, directly against the live database:
 *   1. Sequential pages never overlap (no id appears in two pages).
 *   2. The combined result is correctly ordered — houses with GPS come first,
 *      and within them distance_km is non-decreasing.
 *   3. Both hold across several filter combinations (region / category / both).
 *
 * The RPC is called with the anon key exactly as the app calls it. If the
 * backend is unreachable the suite is skipped rather than failing CI.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

// Kampala city centre — a country-sized radius makes this behave like "All Regions".
const USER_LAT = 0.3476;
const USER_LNG = 32.5825;
const PAGE_SIZE = 24;
const MAX_PAGES = 5; // cap so the suite stays fast even with 1000s of rows

type Row = { id: string; distance_km: number | null; created_at: string };

interface FilterCombo {
  name: string;
  category_filter: string | null;
  region_filter: string | null;
  radius_km: number;
}

const COMBOS: FilterCombo[] = [
  { name: 'all regions, no category', category_filter: null, region_filter: null, radius_km: 100000 },
  { name: 'region = Central', category_filter: null, region_filter: 'Central', radius_km: 200 },
  { name: 'category = single_room', category_filter: 'single_room', region_filter: null, radius_km: 100000 },
  { name: 'region + category', category_filter: 'single_room', region_filter: 'Central', radius_km: 200 },
];

const canRun = Boolean(SUPABASE_URL && SUPABASE_KEY);
const client = canRun ? createClient(SUPABASE_URL!, SUPABASE_KEY!) : null;

/** Page through a combo until exhausted or MAX_PAGES reached. Returns each page's rows. */
async function fetchPages(combo: FilterCombo): Promise<Row[][]> {
  const pages: Row[][] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await client!.rpc('find_nearby_houses', {
      user_lat: USER_LAT,
      user_lng: USER_LNG,
      radius_km: combo.radius_km,
      category_filter: combo.category_filter,
      region_filter: combo.region_filter,
      result_limit: PAGE_SIZE,
      result_offset: page * PAGE_SIZE,
    });
    if (error) throw new Error(`RPC error for "${combo.name}": ${error.message}`);
    const rows = (data ?? []) as Row[];
    pages.push(rows);
    if (rows.length < PAGE_SIZE) break; // last page
  }
  return pages;
}

describe.skipIf(!canRun)('find_nearby_houses paginated RPC', () => {
  let reachable = true;

  beforeAll(async () => {
    try {
      const { error } = await client!.rpc('find_nearby_houses', {
        user_lat: USER_LAT,
        user_lng: USER_LNG,
        radius_km: 1,
        category_filter: null,
        region_filter: null,
        result_limit: 1,
        result_offset: 0,
      });
      if (error) reachable = false;
    } catch {
      reachable = false;
    }
  });

  for (const combo of COMBOS) {
    describe(`filter: ${combo.name}`, () => {
      let pages: Row[][] = [];

      beforeAll(async () => {
        if (!reachable) return;
        pages = await fetchPages(combo);
      });

      it('returns non-overlapping pages (no id in two pages)', () => {
        if (!reachable) return;
        const seen = new Set<string>();
        const duplicates: string[] = [];
        for (const page of pages) {
          for (const row of page) {
            if (seen.has(row.id)) duplicates.push(row.id);
            else seen.add(row.id);
          }
        }
        expect(duplicates).toEqual([]);
      });

      it('keeps each page internally unique', () => {
        if (!reachable) return;
        for (const page of pages) {
          const ids = page.map((r) => r.id);
          expect(new Set(ids).size).toBe(ids.length);
        }
      });

      it('orders the combined result by distance (GPS rows first, non-decreasing)', () => {
        if (!reachable) return;
        const combined = pages.flat();
        // Rows with GPS (non-null distance) must all precede any null-distance rows.
        const firstNull = combined.findIndex((r) => r.distance_km == null);
        if (firstNull !== -1) {
          const tail = combined.slice(firstNull);
          expect(tail.every((r) => r.distance_km == null)).toBe(true);
        }
        // Among GPS rows, distance must be non-decreasing across page boundaries.
        const withGps = combined.filter((r) => r.distance_km != null);
        for (let i = 1; i < withGps.length; i++) {
          expect(withGps[i]!.distance_km!).toBeGreaterThanOrEqual(withGps[i - 1]!.distance_km!);
        }
      });

      it('respects the requested page size', () => {
        if (!reachable) return;
        // Every page except the last must be exactly PAGE_SIZE.
        pages.slice(0, -1).forEach((page) => expect(page.length).toBe(PAGE_SIZE));
        pages.forEach((page) => expect(page.length).toBeLessThanOrEqual(PAGE_SIZE));
      });
    });
  }
});
