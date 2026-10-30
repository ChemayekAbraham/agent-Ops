/**
 * Selected places for the Tenant Locations page. Keyed by the stable path key,
 * so the selection survives new searches and navigation, and is remembered for
 * the browser tab (sessionStorage) while the person moves around the app.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TlbSelectedPlace } from '@/hooks/useTenantLocationsBrowser';
import {
  addSelections, loadStoredSelection, removeSelection, selectionList, storeSelection, toggleSelection,
  type TlbSelection,
} from '@/lib/tenantLocationSelection';

const session = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
};

export function useTlbSelection() {
  const [selection, setSelection] = useState<TlbSelection>(() => loadStoredSelection(session()));

  useEffect(() => {
    storeSelection(session(), selection);
  }, [selection]);

  const toggle = useCallback((place: TlbSelectedPlace) => setSelection((s) => toggleSelection(s, place)), []);
  const addMany = useCallback((places: readonly TlbSelectedPlace[]) => setSelection((s) => addSelections(s, places)), []);
  const removeMany = useCallback((keys: readonly string[]) => setSelection((s) => keys.reduce(removeSelection, s)), []);
  const remove = useCallback((key: string) => setSelection((s) => removeSelection(s, key)), []);
  const clear = useCallback(() => setSelection({}), []);

  const places = useMemo(() => selectionList(selection), [selection]);
  return { selection, places, toggle, addMany, remove, removeMany, clear };
}
