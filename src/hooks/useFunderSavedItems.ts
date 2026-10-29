import { useCallback, useSyncExternalStore } from 'react';
import { EMPTY_FUNDER_SAVED, FUNDER_SAVED_KEY, parseFunderSaved, reconcileFunderSaved, toggleFunderSaved, type FunderSavedState } from '@/lib/funderSavedItems';

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached = EMPTY_FUNDER_SAVED;
function snapshot() {
  try {
    const raw = window.localStorage.getItem(FUNDER_SAVED_KEY);
    if (raw !== cachedRaw) { cachedRaw = raw; cached = parseFunderSaved(raw); }
  } catch { /* Storage unavailable: retain this tab's in-memory bookmarks. */ }
  return cached;
}
function notify() { listeners.forEach((listener) => listener()); }
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === FUNDER_SAVED_KEY || event.key === null) notify(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}
function update(change: (current: FunderSavedState) => FunderSavedState) {
  const next = change(snapshot());
  if (next === cached) return;
  const previousRaw = cachedRaw;
  cached = next;
  cachedRaw = JSON.stringify(next);
  try { window.localStorage.setItem(FUNDER_SAVED_KEY, cachedRaw); }
  catch { cachedRaw = previousRaw; }
  notify();
}
export function useFunderSavedItems() {
  const saved = useSyncExternalStore(subscribe, snapshot, () => EMPTY_FUNDER_SAVED);
  const toggleSave = useCallback((category: 'empty' | 'ready', id: string) => update((current) => toggleFunderSaved(current, category, id)), []);
  const reconcile = useCallback((available: FunderSavedState, checked: FunderSavedState) => update((current) => {
    // A save made during an in-flight read must not be removed by that older read.
    const preserveNew = (category: 'empty' | 'ready') => current[category].filter((id) => !checked[category].includes(id));
    return reconcileFunderSaved(current, { empty: [...available.empty, ...preserveNew('empty')], ready: [...available.ready, ...preserveNew('ready')] });
  }), []);
  return { saved, toggleSave, reconcile, count: saved.empty.length + saved.ready.length };
}