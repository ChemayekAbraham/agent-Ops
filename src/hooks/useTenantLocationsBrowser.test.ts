import { describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));

import {
  childToPath, fetchTlbTenantsMulti, logTlbLocationPdfExport, placeFromHit, placeFromPath,
  tlbPathKey, toRpcPaths, type TlbLocationHit,
} from './useTenantLocationsBrowser';

const hit = (over: Partial<TlbLocationHit>): TlbLocationHit => ({
  kind: 'village', label: 'Kisenyi', path_label: 'Kisenyi I, Makindye, Kampala', region: 'Central',
  district_id: 7, county_id: 70, subcounty_id: 700, parish_id: 7000, village_id: 70000, tenant_count: 12, ...over,
});

describe('tlbPathKey', () => {
  it('is the same for the same place however it was reached', () => {
    const viaHit = placeFromHit(hit({})).path;
    const viaDrill = childToPath(
      { region: 'Central', districtId: 7, districtName: 'Kampala', countyId: 70, subcountyId: 700, parishId: 7000 },
      'village', 70000, 'Kisenyi', false,
    )!;
    expect(tlbPathKey(viaHit)).toBe(tlbPathKey(viaDrill));
  });
  it('differs between a district and a village inside it, and for unmapped', () => {
    expect(tlbPathKey({ region: 'Central', districtId: 7 })).not.toBe(tlbPathKey({ region: 'Central', districtId: 7, villageId: 1 }));
    expect(tlbPathKey({ unmapped: true })).toBe('unmapped');
  });
});

describe('places', () => {
  it('builds the full path largest to smallest from a search hit', () => {
    expect(placeFromHit(hit({})).fullPath).toEqual(['Central', 'Kampala', 'Makindye', 'Kisenyi I', 'Kisenyi']);
    expect(placeFromHit(hit({ kind: 'district', label: 'Kampala', path_label: 'Central' })).fullPath).toEqual(['Central', 'Kampala']);
  });
  it('labels a drilled path by its last known name', () => {
    expect(placeFromPath({ region: 'Central', districtId: 7, districtName: 'Kampala' }).label).toBe('Kampala');
  });
});

describe('server calls', () => {
  it('sends paths in selection order and returns the distinct total', async () => {
    rpc.mockResolvedValueOnce({
      data: [
        { tenant_id: 'a', matched_path_index: '0', total_count: '2' },
        { tenant_id: 'b', matched_path_index: '1', total_count: '2' },
      ], error: null,
    });
    const places = [placeFromPath({ region: 'Central', districtId: 7, districtName: 'Kampala' }), placeFromPath({ unmapped: true })];
    const res = await fetchTlbTenantsMulti(places, 'active');
    expect(rpc).toHaveBeenCalledWith('tlb_tenants_multi', { p_paths: toRpcPaths(places), p_status: 'active', p_limit: 5000 });
    expect(res.total).toBe(2);
    expect(res.rows.map((r) => r.matched_path_index)).toEqual([0, 1]);
  });
  it('logs the export with a reason of at least 10 characters', async () => {
    rpc.mockResolvedValueOnce({ data: 'id', error: null });
    await logTlbLocationPdfExport({ places: [placeFromPath({ unmapped: true })], tenants: 3, status: 'all' });
    const args = rpc.mock.calls.at(-1)![1];
    expect(args.p_reason.length).toBeGreaterThanOrEqual(10);
    expect(args.p_places).toBe(1);
  });
});
