import { useEffect, useState, type RefObject } from 'react';

/**
 * Layout classes for the funder V3 screens (Material-style window classes).
 *
 *  • compact   < 640  — phones: full-bleed map, bottom sheet
 *  • medium    640–1023 — large phones / tablets: same, sheet centred (max 720px)
 *  • expanded  ≥ 1024 — split view: list pane left, map right
 */
export type LayoutMode = 'compact' | 'medium' | 'expanded';

export const MEDIUM_MIN = 640;
export const EXPANDED_MIN = 1024;

export function layoutModeFor(width: number): LayoutMode {
  if (width >= EXPANDED_MIN) return 'expanded';
  if (width >= MEDIUM_MIN) return 'medium';
  return 'compact';
}

function currentWidth(target?: HTMLElement | null): number {
  if (target) return target.clientWidth;
  if (typeof document !== 'undefined' && document.documentElement) {
    return document.documentElement.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0);
  }
  return typeof window !== 'undefined' ? window.innerWidth : 0;
}

/**
 * Live layout mode. A ResizeObserver on the root (or the given element) catches
 * every width change, including ones the window never reports (a split-screen
 * pane, a DevTools dock); matchMedia catches breakpoint crossings and rotation
 * on browsers that throttle ResizeObserver while hidden. Only a mode change
 * re-renders; plain width changes inside one mode do not.
 */
export function useLayoutMode(targetRef?: RefObject<HTMLElement | null>): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(() => layoutModeFor(currentWidth()));

  useEffect(() => {
    const target = targetRef?.current ?? document.documentElement;
    const update = () => setMode(layoutModeFor(currentWidth(targetRef?.current ?? null)));
    update();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update);
      observer.observe(target);
    }

    const queries = typeof window.matchMedia === 'function'
      ? [`(min-width: ${MEDIUM_MIN}px)`, `(min-width: ${EXPANDED_MIN}px)`, '(orientation: portrait)'].map((q) => window.matchMedia(q))
      : [];
    queries.forEach((query) => query.addEventListener?.('change', update));
    window.addEventListener('resize', update);

    return () => {
      observer?.disconnect();
      queries.forEach((query) => query.removeEventListener?.('change', update));
      window.removeEventListener('resize', update);
    };
  }, [targetRef]);

  return mode;
}

/**
 * The height actually visible to the person, kept live: window resizes,
 * rotation, and the on-screen keyboard (visualViewport) all update it. Used for
 * the bottom sheet's snap heights, which must never be read once and cached.
 */
export function useViewportHeight(): number {
  const read = () => {
    if (typeof window === 'undefined') return 800;
    return Math.round(window.visualViewport?.height ?? window.innerHeight);
  };
  const [height, setHeight] = useState(read);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setHeight(read());
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', update);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      vv?.removeEventListener('resize', update);
    };
  }, []);

  return height;
}

/** True when the person asked the system for less motion. Live. */
export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const update = () => setReduced(mql.matches);
    mql.addEventListener?.('change', update);
    return () => mql.removeEventListener?.('change', update);
  }, []);
  return reduced;
}
