export const FUNDER_SAVED_KEY = 'rentflow:funder-new:saved:v1';
export interface FunderSavedState { empty: string[]; ready: string[] }
export const EMPTY_FUNDER_SAVED: FunderSavedState = { empty: [], ready: [] };

export function parseFunderSaved(raw: string | null): FunderSavedState {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_FUNDER_SAVED;
    const record = value as Record<string, unknown>;
    const ids = (list: unknown) => Array.isArray(list)
      ? [...new Set(list.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : [];
    return { empty: ids(record.empty), ready: ids(record.ready) };
  } catch { return EMPTY_FUNDER_SAVED; }
}

export function toggleFunderSaved(current: FunderSavedState, category: 'empty' | 'ready', id: string): FunderSavedState {
  return { ...current, [category]: current[category].includes(id)
    ? current[category].filter((value) => value !== id) : [...current[category], id] };
}

/** Call only with a complete, successful, unfiltered availability read. */
export function reconcileFunderSaved(current: FunderSavedState, available: FunderSavedState): FunderSavedState {
  const empty = new Set(available.empty), ready = new Set(available.ready);
  const next = { empty: current.empty.filter((id) => empty.has(id)), ready: current.ready.filter((id) => ready.has(id)) };
  return next.empty.length === current.empty.length && next.ready.length === current.ready.length ? current : next;
}