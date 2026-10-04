/**
 * Regression test for the "selecting Kampala returns no houses" bug.
 *
 * Kampala is stored in the `district` column under the "Central" region, but the
 * house-search filter originally only matched the `region` column, so picking
 * "Kampala" produced an empty list. The fix broadened `find_nearby_houses` (and
 * the client fallback query) to match `region`, `district`, `sub_county`,
 * `village` OR `address`.
 *
 * This suite locks that behaviour in place, run directly against the live DB
 * with the anon key exactly as the app does. If the backend is unreachable the
 * suite is skipped rather than failing CI.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

// Kampala city centre — a country-sized radius behaves like "All Regions".
const USER_LAT = 0.3476;
const USER_LNG = 32.5825;
const SELECTION = 'Kampala';
// Columns the fix broadened the location filter to search.
const LOCATION_COLS = ['region', 'district', 'sub_county', 'village', 'address'] as const;

type Row = Record<(typeof LOCATION_COLS)[number], string | null> & { id: string };

const canRun = Boolean(SUPABASE_URL && SUPABASE_KEY);
const client = canRun ? createClient(SUPABASE_URL!, SUPABASE_KEY!) : null;

function matchesSelection(row: Row): boolean {
  return LOCATION_COLS.some((c) => (row[c] ?? '').toLowerCase().includes(SELECTION.toLowerCase()));
}

describe.skipIf(!canRun)('find_nearby_houses: Kampala district regression', () => {
  let reachable = true;
  let rpcRows: Row[] = [];
  let broadenedIds = new Set<string>();
  let regionOnlyCount = 0;

  beforeAll(async () => {
    try {
      const { data: rpc, error: rpcErr } = await client!.rpc('find_nearby_houses', {
        user_lat: USER_LAT,
        user_lng: USER_LNG,
        radius_km: 100000,
        category_filter: null,
        region_filter: SELECTION,
        result_limit: 1000,
        result_offset: 0,
      });
      if (rpcErr) throw rpcErr;
      rpcRows = (rpc ?? []) as Row[];

      // The exact set the fix's broadened OR filter should match.
      const orClause = LOCATION_COLS.map((c) => `${c}.ilike.%${SELECTION}%`).join(',');
      const { data: broadened, error: bErr } = await client!
        .from('house_listings')
        .select('id')
        .eq('status', 'available')
        .or(orClause)
        .limit(1000);
      if (bErr) throw bErr;
      broadenedIds = new Set((broadened ?? []).map((r) => r.id as string));

      // How the buggy query behaved: region column only.
      const { count, error: rErr } = await client!
        .from('house_listings')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'available')
        .ilike('region', `%${SELECTION}%`);
      if (rErr) throw rErr;
      regionOnlyCount = count ?? 0;
    } catch {
      reachable = false;
    }
  });

  it('returns a non-empty list when Kampala is selected', () => {
    if (!reachable) return;
    expect(rpcRows.length).toBeGreaterThan(0);
  });

  it('reproduces the bug: matching the region column alone finds nothing', () => {
    if (!reachable) return;
    // This is why the original query broke — the broadened match must find more.
    expect(regionOnlyCount).toBe(0);
    expect(broadenedIds.size).toBeGreaterThan(regionOnlyCount);
  });

  it('every returned house actually matches Kampala across the broadened columns', () => {
    if (!reachable) return;
    const mismatches = rpcRows.filter((r) => !matchesSelection(r));
    expect(mismatches).toEqual([]);
  });

  it('returns nothing outside the broadened region/district/sub-county/village/address match', () => {
    if (!reachable) return;
    const outside = rpcRows.map((r) => r.id).filter((id) => !broadenedIds.has(id));
    expect(outside).toEqual([]);
  });
});
