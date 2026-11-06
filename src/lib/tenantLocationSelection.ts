/**
 * Pure selection and grouping logic for the Tenant Locations multi-select.
 * Read-only reporting: nothing here touches the database, wallets or Rent Plans.
 */
import {
  TLB_MULTI_MAX_TENANTS,
  type TlbMultiTenant,
  type TlbSelectedPlace,
  type TlbStatus,
} from '@/hooks/useTenantLocationsBrowser';

export type TlbSelection = Readonly<Record<string, TlbSelectedPlace>>;

export const toggleSelection = (sel: TlbSelection, place: TlbSelectedPlace): TlbSelection => {
  if (sel[place.key]) {
    const { [place.key]: _removed, ...rest } = sel;
    return rest;
  }
  return { ...sel, [place.key]: place };
};

export const addSelections = (sel: TlbSelection, places: readonly TlbSelectedPlace[]): TlbSelection => {
  const next: Record<string, TlbSelectedPlace> = { ...sel };
  for (const p of places) if (!next[p.key]) next[p.key] = p;
  return next;
};

export const removeSelection = (sel: TlbSelection, key: string): TlbSelection => {
  const { [key]: _removed, ...rest } = sel;
  return rest;
};

/** Selected places in the order they were added (object keys keep insertion order). */
export const selectionList = (sel: TlbSelection): TlbSelectedPlace[] => Object.values(sel);

/** True when every one of `places` is already selected (drives "Select all" / "Clear all"). */
export const allSelected = (sel: TlbSelection, places: readonly TlbSelectedPlace[]): boolean =>
  places.length > 0 && places.every((p) => !!sel[p.key]);

export interface TlbPlaceSection {
  place: TlbSelectedPlace;
  rows: TlbMultiTenant[];
  total: number;
  active: number;
  inactive: number;
}

export interface TlbPlaceReport {
  sections: TlbPlaceSection[];
  grand: { total: number; active: number; inactive: number };
}

/**
 * Groups the combined tenant list by the place each tenant was credited to
 * (matched_path_index = position in the selection sent to the server). Each
 * tenant appears once, so section totals always add up to the grand total.
 * Places with no tenants keep a section with zero counts.
 */
export function groupTenantsByPlace(
  places: readonly TlbSelectedPlace[],
  rows: readonly TlbMultiTenant[],
): TlbPlaceReport {
  const sections: TlbPlaceSection[] = places.map((place) => ({ place, rows: [], total: 0, active: 0, inactive: 0 }));
  const seen = new Set<string>();
  for (const row of rows) {
    // The server already returns one row per tenant; this keeps a repeated row
    // from ever being counted twice, whatever produced the list.
    if (seen.has(row.tenant_id)) continue;
    const section = sections[row.matched_path_index];
    if (!section) continue;
    seen.add(row.tenant_id);
    section.rows.push(row);
    section.total += 1;
    if (row.is_active) section.active += 1; else section.inactive += 1;
  }
  const grand = sections.reduce(
    (g, s) => ({ total: g.total + s.total, active: g.active + s.active, inactive: g.inactive + s.inactive }),
    { total: 0, active: 0, inactive: 0 },
  );
  return { sections, grand };
}

export class TlbTooManyTenantsError extends Error {
  constructor(public readonly total: number, public readonly max: number = TLB_MULTI_MAX_TENANTS) {
    super(`${total} tenants match; the limit is ${max}. Select fewer places or use the Active or Inactive filter.`);
    this.name = 'TlbTooManyTenantsError';
  }
}

/** Throws when the full result is larger than the export cap. */
export function assertWithinExportCap(total: number, max: number = TLB_MULTI_MAX_TENANTS): void {
  if (total > max) throw new TlbTooManyTenantsError(total, max);
}

export const STATUS_LABEL: Record<TlbStatus, string> = {
  all: 'All tenants',
  active: 'Active only',
  inactive: 'Inactive only',
};

// -- Remembering the selection while the person moves around the app ----------

const STORAGE_KEY = 'welile.tlb.selection.v1';

export function loadStoredSelection(storage: Pick<Storage, 'getItem'> | null | undefined): TlbSelection {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, TlbSelectedPlace> = {};
    for (const [key, v] of Object.entries(parsed as Record<string, TlbSelectedPlace>)) {
      if (v && typeof v.key === 'string' && v.key === key && Array.isArray(v.fullPath) && v.path && typeof v.label === 'string') {
        out[key] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function storeSelection(storage: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined, sel: TlbSelection): void {
  try {
    if (!storage) return;
    if (Object.keys(sel).length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(sel));
  } catch {
    /* private mode or storage disabled: the selection simply lives in memory */
  }
}
