import { useEffect, useState } from 'react';

/**
 * Small UI-only state helper that survives a page unload/reload within the same
 * tab (e.g. an officer tapping a `tel:` link on a handset and coming back).
 *
 * Purely presentational: it stores no business data, only the view state such
 * as the active tab, search text, sort choice and which row was open.
 */
export function useSessionPersistedState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      /* ignore unavailable/corrupt storage */
    }
    return initial;
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore quota / private-mode failures */
    }
  }, [key, value]);

  return [value, setValue] as const;
}
