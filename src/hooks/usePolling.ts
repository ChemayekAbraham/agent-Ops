import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Periodically re-run a loader, as the replacement for Supabase Realtime
 * listeners on screens that don't need push updates (doc 147).
 *
 * - Ticks every `intervalMs` while the tab is visible; skips ticks while it
 *   is hidden, and refreshes as soon as the tab/window becomes active again.
 * - `immediate: true` also runs the loader on mount — use it when this hook
 *   replaces the component's own initial-load effect; leave it off when the
 *   component already loads on mount.
 * - The latest `load` is always used, so passing an inline function is fine
 *   and does not restart the timer.
 *
 * Returns `lastUpdatedAt` (set after each successful load) and `refresh()`
 * for "Updated Xs ago" labels and manual refresh buttons.
 */
export function usePolling(
  load: () => unknown,
  intervalMs: number,
  opts: { enabled?: boolean; immediate?: boolean } = {},
): { lastUpdatedAt: Date | null; refresh: () => Promise<void> } {
  const { enabled = true, immediate = false } = opts;
  const loadRef = useRef(load);
  loadRef.current = load;
  const mountedRef = useRef(true);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastRunRef = useRef(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    lastRunRef.current = Date.now();
    const p = (async () => {
      try {
        await loadRef.current();
        if (mountedRef.current) setLastUpdatedAt(new Date());
      } catch (e) {
        console.warn('usePolling: load failed', e);
      } finally {
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = p;
    return p;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (immediate) void refresh();

    const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const timer = setInterval(() => {
      if (!isHidden()) void refresh();
    }, intervalMs);

    // Coming back to the tab: refresh unless we just did (focus and
    // visibilitychange often fire together).
    const onActive = () => {
      if (!isHidden() && Date.now() - lastRunRef.current > 5_000) void refresh();
    };
    window.addEventListener('focus', onActive);
    document.addEventListener('visibilitychange', onActive);

    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onActive);
      document.removeEventListener('visibilitychange', onActive);
    };
  }, [enabled, immediate, intervalMs, refresh]);

  return { lastUpdatedAt, refresh };
}
