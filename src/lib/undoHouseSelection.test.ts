import { describe, it, expect } from 'vitest';
import {
  computeUndoSelection,
  EMPTY_INLINE_HOUSE_FIELDS,
  type InlineHouseFields,
} from './undoHouseSelection';

describe('computeUndoSelection', () => {
  it('fully clears selectedHouse and selectedLandlord', () => {
    const { snapshot } = computeUndoSelection({ houseQuery: 'Kira' });
    expect(snapshot.selectedHouse).toBeNull();
    expect(snapshot.selectedLandlord).toBeNull();
    expect(snapshot.houseConflict).toBe(false);
  });

  it('restores (preserves) the previous picker search query', () => {
    expect(computeUndoSelection({ houseQuery: 'Nansana 256700' }).snapshot.houseQuery).toBe(
      'Nansana 256700',
    );
    expect(computeUndoSelection({ houseQuery: '' }).snapshot.houseQuery).toBe('');
  });

  it('re-runs the search only when the preserved query is non-empty', () => {
    expect(computeUndoSelection({ houseQuery: 'Kampala' }).rerunSearch).toBe(true);
    expect(computeUndoSelection({ houseQuery: '   ' }).rerunSearch).toBe(false);
    expect(computeUndoSelection({ houseQuery: '' }).rerunSearch).toBe(false);
  });

  it('leaves no inline field stale — every field resets to empty', () => {
    const { snapshot } = computeUndoSelection({ houseQuery: 'x' });
    const expected: InlineHouseFields = {
      rentAmount: '',
      landlordName: '',
      landlordPhone: '',
      propertyAddress: '',
      propertyDistrict: '',
      propertyCity: '',
      houseCategory: '',
      gpsLocation: null,
    };
    expect(snapshot.fields).toEqual(expected);
    // Guard against new fields being added to InlineHouseFields without a reset.
    expect(Object.keys(snapshot.fields).sort()).toEqual(
      Object.keys(EMPTY_INLINE_HOUSE_FIELDS).sort(),
    );
  });

  it('returns a fresh fields object (not a shared mutable reference)', () => {
    const a = computeUndoSelection({ houseQuery: 'a' });
    const b = computeUndoSelection({ houseQuery: 'b' });
    expect(a.snapshot.fields).not.toBe(b.snapshot.fields);
    expect(a.snapshot.fields).not.toBe(EMPTY_INLINE_HOUSE_FIELDS);
  });

  it('tolerates a missing query (defaults to empty, no re-run)', () => {
    const { snapshot, rerunSearch } = computeUndoSelection({
      houseQuery: undefined as unknown as string,
    });
    expect(snapshot.houseQuery).toBe('');
    expect(rerunSearch).toBe(false);
  });
});
