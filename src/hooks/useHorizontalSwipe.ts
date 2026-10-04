import { useRef, useMemo } from 'react';
import type { TouchEvent as ReactTouchEvent } from 'react';

interface SwipeOptions {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  /** Minimum horizontal distance (px) to count as a swipe. */
  threshold?: number;
  /** Maximum vertical drift (px) before the gesture is treated as a scroll. */
  maxVertical?: number;
}

interface SwipeHandlers {
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchEnd: (e: ReactTouchEvent) => void;
}

/**
 * Returns `onTouchStart` / `onTouchEnd` handlers to spread onto a container for
 * left/right swipe navigation (e.g. flipping dashboard sections on a phone).
 *
 * A swipe must be: mostly horizontal (vertical drift <= maxVertical), longer
 * than `threshold`, and completed within 600ms — otherwise it's treated as a
 * scroll or long-press and ignored. Swipes starting inside a horizontally
 * scrollable area, form control, or `[data-swipe-ignore]` node are skipped.
 */
export function useHorizontalSwipe({
  onSwipeLeft,
  onSwipeRight,
  threshold = 60,
  maxVertical = 60,
}: SwipeOptions): SwipeHandlers {
  const start = useRef<{ x: number; y: number; t: number } | null>(null);

  return useMemo<SwipeHandlers>(() => {
    const shouldIgnore = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      return !!target.closest(
        '[data-swipe-ignore], .overflow-x-auto, input, textarea, select, [role="slider"], [contenteditable="true"]',
      );
    };

    return {
      onTouchStart: (e: ReactTouchEvent) => {
        const touch = e.touches?.[0];
        if (!touch || shouldIgnore(e.target)) {
          start.current = null;
          return;
        }
        start.current = { x: touch.clientX, y: touch.clientY, t: Date.now() };
      },
      onTouchEnd: (e: ReactTouchEvent) => {
        const s = start.current;
        start.current = null;
        if (!s) return;
        const touch = e.changedTouches?.[0];
        if (!touch) return;
        const dx = touch.clientX - s.x;
        const dy = touch.clientY - s.y;
        const dt = Date.now() - s.t;
        if (dt > 600) return; // too slow — long-press / drift
        if (Math.abs(dy) > maxVertical) return; // vertical scroll
        if (Math.abs(dx) < threshold) return; // too short
        if (dx < 0) onSwipeLeft?.();
        else onSwipeRight?.();
      },
    };
  }, [onSwipeLeft, onSwipeRight, threshold, maxVertical]);
}
