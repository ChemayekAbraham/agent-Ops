/**
 * Pure helpers for the rent-request house picker "Undo" action.
 *
 * Keeping the reset logic here (instead of inline in the dialog) means the
 * behaviour can be unit-tested without rendering the very large
 * AgentRentRequestDialog component, and guarantees that every field
 * populated by `selectHouse` is cleared by `undoSelectHouse`.
 */

export interface InlineHouseFields {
  rentAmount: string;
  landlordName: string;
  landlordPhone: string;
  propertyAddress: string;
  propertyDistrict: string;
  propertyCity: string;
  houseCategory: string;
  gpsLocation: { lat: number; lng: number; accuracy: number } | null;
}

/** The canonical "empty" value for every inline field selectHouse can fill. */
export const EMPTY_INLINE_HOUSE_FIELDS: InlineHouseFields = {
  rentAmount: '',
  landlordName: '',
  landlordPhone: '',
  propertyAddress: '',
  propertyDistrict: '',
  propertyCity: '',
  houseCategory: '',
  gpsLocation: null,
};

export interface HouseSelectionSnapshot {
  selectedHouse: unknown | null;
  selectedLandlord: unknown | null;
  houseConflict: boolean;
  houseQuery: string;
  fields: InlineHouseFields;
}

export interface UndoResult {
  snapshot: HouseSelectionSnapshot;
  /** Whether the previous picker search should be re-run. */
  rerunSearch: boolean;
}

/**
 * Compute the fully-reverted state after pressing "Undo" on a selected house.
 *
 * - clears `selectedHouse` and `selectedLandlord`
 * - clears the conflict flag
 * - resets every inline field to its empty value (no stale landlord/rent/location)
 * - preserves `houseQuery` so the picker re-opens with the same search
 * - re-runs the search when there is a non-empty query
 */
export function computeUndoSelection(
  current: Pick<HouseSelectionSnapshot, 'houseQuery'>,
): UndoResult {
  const houseQuery = current.houseQuery ?? '';
  return {
    snapshot: {
      selectedHouse: null,
      selectedLandlord: null,
      houseConflict: false,
      houseQuery,
      fields: { ...EMPTY_INLINE_HOUSE_FIELDS },
    },
    rerunSearch: houseQuery.trim().length > 0,
  };
}
