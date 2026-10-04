import { useCallback, useEffect, useState } from 'react';

/**
 * Persists a per-role swipe sensitivity as a pixel `threshold` (the minimum
 * horizontal distance required to flip a dashboard section). Lower threshold =
 * easier/more sensitive swipes. Stored in localStorage so the choice sticks per
 * device and syncs across tabs.
 */
export const SWIPE_THRESHOLD_MIN = 30; // most sensitive
export const SWIPE_THRESHOLD_MAX = 130; // least sensitive
export const SWIPE_THRESHOLD_DEFAULT = 60;

const clamp = (n: number) =>
  Math.min(SWIPE_THRESHOLD_MAX, Math.max(SWIPE_THRESHOLD_MIN, Math.round(n)));

export function useSwipeSensitivity(role: string) {
  const storageKey = `dashboard:${role}:swipeThreshold`;

  const [threshold, setThresholdState] = useState<number>(() => {
    if (typeof window === 'undefined') return SWIPE_THRESHOLD_DEFAULT;
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed = raw == null ? NaN : Number(raw);
      return Number.isFinite(parsed) ? clamp(parsed) : SWIPE_THRESHOLD_DEFAULT;
    } catch {
      return SWIPE_THRESHOLD_DEFAULT;
    }
  });

  const setThreshold = useCallback(
    (value: number) => {
      const next = clamp(value);
      setThresholdState(next);
      try {
        window.localStorage.setItem(storageKey, String(next));
      } catch {
        /* storage unavailable */
      }
    },
    [storageKey],
  );

  // Mirror changes made in other tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== storageKey) return;
      const parsed = e.newValue == null ? NaN : Number(e.newValue);
      setThresholdState(Number.isFinite(parsed) ? clamp(parsed) : SWIPE_THRESHOLD_DEFAULT);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey]);

  return { threshold, setThreshold };
}
