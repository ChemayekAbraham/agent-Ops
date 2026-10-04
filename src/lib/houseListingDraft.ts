/**
 * Persistent draft for the "List Empty House" wizard.
 *
 * On mobile, opening the camera / file picker can cause the browser to reload
 * the page (memory pressure, PWA cold-restart), which tears down the dialog and
 * every React state value the agent had typed. To avoid making them start over,
 * we mirror the text portion of the wizard into localStorage as they go and
 * restore it the next time the dialog opens.
 *
 * NOTE: Selected photos (File / blob URLs) cannot survive a full page reload and
 * are intentionally NOT persisted — the agent re-adds photos, everything else is
 * restored.
 */

const STORAGE_KEY = 'welile_house_listing_draft';
// Don't resurrect a draft the agent abandoned long ago.
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface HouseListingDraft {
  form: Record<string, unknown>;
  step: number;
  showOptional: boolean;
  manualLandlord: boolean;
  selectedLandlord: unknown;
  lc1Selection: unknown;
  geo: { lat: number; lng: number; accuracy: number | null } | null;
  geoConfirmed: boolean;
  landlordQuery: string;
  savedAt: number;
}

/** True when the draft holds enough typed data to be worth restoring. */
export function draftHasContent(draft: Partial<HouseListingDraft> | null | undefined): boolean {
  if (!draft) return false;
  const f = (draft.form ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string).trim() : '');
  const typedSomething =
    !!str('title') ||
    !!str('description') ||
    !!str('monthly_rent') ||
    !!str('address') ||
    !!str('landlord_name') ||
    !!str('landlord_phone') ||
    !!str('caretaker_name') ||
    !!str('caretaker_phone') ||
    !!str('lc1_name') ||
    !!str('lc1_phone');
  return (
    typedSomething ||
    (typeof draft.step === 'number' && draft.step > 1) ||
    !!draft.selectedLandlord ||
    !!draft.lc1Selection ||
    !!draft.geo
  );
}

export function saveHouseListingDraft(draft: Omit<HouseListingDraft, 'savedAt'>): void {
  try {
    if (!draftHasContent(draft)) {
      // Nothing meaningful to keep — make sure we don't leave a stale draft.
      clearHouseListingDraft();
      return;
    }
    const payload: HouseListingDraft = { ...draft, savedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable (private mode / quota) — ignore */
  }
}

export function loadHouseListingDraft(): HouseListingDraft | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HouseListingDraft;
    if (!parsed || typeof parsed !== 'object') return null;
    if (Date.now() - (parsed.savedAt || 0) > MAX_AGE_MS) {
      clearHouseListingDraft();
      return null;
    }
    if (!draftHasContent(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearHouseListingDraft(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
