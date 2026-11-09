import { useCallback, useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../deskTheme';

export type Fade = 'none' | 'start' | 'end' | 'both';

/** Which edges of a sideways-scrolling row have more behind them. One pixel of slack for sub-pixel scrolls. */
export function fadeEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): Fade {
  const before = scrollLeft > 1;
  const after = scrollLeft + clientWidth < scrollWidth - 1;
  if (before && after) return 'both';
  if (before) return 'start';
  if (after) return 'end';
  return 'none';
}

/** The scroll that brings a child fully into view (with `pad` of air), or null when it already is. */
export function scrollTargetFor(left: number, width: number, scrollLeft: number, clientWidth: number, pad = 44): number | null {
  if (left - pad < scrollLeft) return Math.max(0, left - pad);
  if (left + width + pad > scrollLeft + clientWidth) return left + width + pad - clientWidth;
  return null;
}

/**
 * A sideways-scrolling row (tab bar, segmented control, pipeline strip):
 * reports which edge to fade and brings the active child into view on load
 * and whenever `activeKey` changes. The row must be `position: relative` so
 * child offsets are measured from it.
 */
export function useFadeEdges<T extends HTMLElement>(activeSelector: string | null, deps: unknown[] = []) {
  const ref = useRef<T | null>(null);
  const [fade, setFade] = useState<Fade>('none');
  const first = useRef(true);

  const measure = useCallback(() => {
    const el = ref.current;
    if (el) setFade(fadeEdges(el.scrollLeft, el.clientWidth, el.scrollWidth));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [measure]);

  useEffect(() => {
    const el = ref.current;
    const child = activeSelector ? el?.querySelector<HTMLElement>(activeSelector) : null;
    if (el && child) {
      const left = scrollTargetFor(child.offsetLeft, child.offsetWidth, el.scrollLeft, el.clientWidth);
      if (left !== null) {
        const smooth = !first.current && !prefersReducedMotion();
        if (typeof el.scrollTo === 'function') el.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
        else el.scrollLeft = left;
      }
    }
    first.current = false;
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSelector, measure, ...deps]);

  return { ref, fade };
}
