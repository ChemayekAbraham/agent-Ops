import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

import {
  addSelections, allSelected, assertWithinExportCap, groupTenantsByPlace, loadStoredSelection,
  removeSelection, selectionList, storeSelection, TlbTooManyTenantsError, toggleSelection, type TlbSelection,
} from './tenantLocationSelection';
import { placeFromPath, type TlbMultiTenant } from '@/hooks/useTenantLocationsBrowser';

const kampala = placeFromPath({ region: 'Central', districtId: 7, districtName: 'Kampala' });
const kisenyi = placeFromPath({ region: 'Central', districtId: 7, districtName: 'Kampala', villageId: 9, villageName: 'Kisenyi' });
const unmapped = placeFromPath({ unmapped: true });

const row = (id: string, idx: number, active: boolean): TlbMultiTenant => ({
  tenant_id: id, tenant_name: `T ${id}`, tenant_phone: '0700000000', agent_id: null, agent_name: null,
  latest_status: active ? 'funded' : 'rejected', is_active: active, depth: 2, region: 'Central', district_name: 'Kampala',
  county_name: null, subcounty_name: null, parish_name: null, village_name: null, legacy_location: null,
  matched_path_index: idx, total_count: 0,
});

describe('selection', () => {
  it('toggles, adds without duplicates and keeps order', () => {
    let sel: TlbSelection = {};
    sel = toggleSelection(sel, kampala);
    sel = addSelections(sel, [kisenyi, kampala, unmapped]);
    expect(selectionList(sel).map((p) => p.label)).toEqual(['Kampala', 'Kisenyi', 'Unmapped']);
    expect(allSelected(sel, [kampala, kisenyi])).toBe(true);
    sel = toggleSelection(sel, kampala);
    expect(allSelected(sel, [kampala, kisenyi])).toBe(false);
    expect(Object.keys(removeSelection(sel, kisenyi.key))).toEqual([unmapped.key]);
  });

  it('survives a reload: stored and restored by stable key', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const sel = addSelections({}, [kampala, kisenyi]);
    storeSelection(storage, sel);
    expect(Object.keys(loadStoredSelection(storage))).toEqual([kampala.key, kisenyi.key]);
    storeSelection(storage, {});
    expect(loadStoredSelection(storage)).toEqual({});
  });

  it('ignores corrupt or unavailable storage', () => {
    expect(loadStoredSelection({ getItem: () => '{not json' })).toEqual({});
    expect(loadStoredSelection({ getItem: () => JSON.stringify({ a: { key: 'b' } }) })).toEqual({});
    expect(loadStoredSelection(null)).toEqual({});
    expect(() => storeSelection({ setItem: () => { throw new Error('full'); }, removeItem: () => {} }, { [kampala.key]: kampala })).not.toThrow();
  });
});

describe('grouping', () => {
  it('lists a tenant once even if the same tenant is repeated across overlapping places', () => {
    const rows = [row('a', 1, true), row('a', 0, true), row('b', 0, false), row('c', 1, true)];
    const { sections, grand } = groupTenantsByPlace([kampala, kisenyi], rows);
    expect(sections.map((s) => s.rows.map((r) => r.tenant_id))).toEqual([['b'], ['a', 'c']]);
    expect(grand).toEqual({ total: 3, active: 2, inactive: 1 });
  });

  it('section totals always add up to the grand total and keeps empty places', () => {
    const { sections, grand } = groupTenantsByPlace([kampala, kisenyi, unmapped], [row('a', 0, true), row('b', 1, false)]);
    expect(sections.map((s) => s.total)).toEqual([1, 1, 0]);
    expect(sections.reduce((n, s) => n + s.total, 0)).toBe(grand.total);
    expect(grand.active + grand.inactive).toBe(grand.total);
  });

  it('respects the status filter it is given: only the rows the server returned are counted', () => {
    const activeOnly = [row('a', 0, true), row('b', 0, true)];
    const { grand } = groupTenantsByPlace([kampala], activeOnly);
    expect(grand).toEqual({ total: 2, active: 2, inactive: 0 });
  });
});

describe('export cap', () => {
  it('allows 5000 and refuses 5001 with a message that tells the user what to do', () => {
    expect(() => assertWithinExportCap(5000)).not.toThrow();
    expect(() => assertWithinExportCap(5001)).toThrow(TlbTooManyTenantsError);
    expect(() => assertWithinExportCap(5001)).toThrow(/Select fewer places/);
  });
});
