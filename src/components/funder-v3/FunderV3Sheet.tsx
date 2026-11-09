import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { useViewportHeight } from './useLayoutMode';

export type SheetSnap = 'peek' | 'half' | 'full';

export const PEEK_PX = 96;
const DRAG_THRESHOLD_PX = 6;
/** A flick faster than this (px/ms) moves one snap in its direction. */
const FLICK_SPEED = 0.45;

export function snapHeights(viewportHeight: number, topReserve: number) {
  const full = Math.max(PEEK_PX + 120, viewportHeight - topReserve);
  const half = Math.min(full, Math.max(PEEK_PX + 80, Math.round(viewportHeight * 0.5)));
  return { peek: PEEK_PX, half, full } as const;
}

export function nearestSnap(height: number, heights: ReturnType<typeof snapHeights>, velocity = 0): SheetSnap {
  const order: SheetSnap[] = ['peek', 'half', 'full'];
  if (Math.abs(velocity) > FLICK_SPEED) {
    // velocity > 0: finger moving down (sheet shrinking) → next snap below; else next snap above.
    if (velocity > 0) {
      const below = [...order].reverse().find((snap) => heights[snap] < height);
      return below ?? 'peek';
    }
    const above = order.find((snap) => heights[snap] > height);
    return above ?? 'full';
  }
  return order.reduce((best, snap) => (Math.abs(heights[snap] - height) < Math.abs(heights[best] - height) ? snap : best), 'peek' as SheetSnap);
}

/**
 * Bottom sheet for the compact and medium layouts.
 *
 *  • Three snaps: peek (96px), half (50% of the visible height), full (up to the
 *    floating search). Heights are recomputed live from the visible viewport, so
 *    rotation, window resizes and the on-screen keyboard never leave it stale.
 *  • The list scrolls at half AND full (native scroll, wheel included). Only the
 *    handle and the header start a drag, so scrolling never fights the sheet.
 *  • Laid out at full height and moved with a CSS transform; while resting at
 *    half, the list gets bottom padding equal to the part below the screen, so
 *    its last card can still be scrolled into view.
 */
export function FunderV3Sheet({
  snap,
  onSnapChange,
  header,
  children,
  topReserve,
  contentRef,
  centred = false,
  bottomPadding = 0,
}: {
  snap: SheetSnap;
  onSnapChange: (snap: SheetSnap) => void;
  header: ReactNode;
  children: ReactNode;
  /** Space kept clear above the sheet at full (the floating search). */
  topReserve: number;
  contentRef: RefObject<HTMLDivElement | null>;
  /** Medium layout: max 720px wide, centred. */
  centred?: boolean;
  /** Extra room under the list (the Map/List toggle). */
  bottomPadding?: number;
}) {
  const viewportHeight = useViewportHeight();
  const heights = snapHeights(viewportHeight, topReserve);
  const heightsRef = useRef(heights);
  heightsRef.current = heights;
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const sheetRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; startY: number; startH: number; lastY: number; lastT: number; velocity: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);

  const restTransform = `translate3d(0, ${heights.full - heights[snap]}px, 0)`;

  const paint = (height: number) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const clamped = Math.max(heightsRef.current.peek, Math.min(heightsRef.current.full, height));
    sheet.style.transform = `translate3d(0, ${heightsRef.current.full - clamped}px, 0)`;
  };

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = {
      id: event.pointerId,
      startY: event.clientY,
      startH: heightsRef.current[snapRef.current],
      lastY: event.clientY,
      lastT: event.timeStamp,
      velocity: 0,
      active: false,
    };
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    const delta = event.clientY - state.startY;
    if (!state.active) {
      if (Math.abs(delta) < DRAG_THRESHOLD_PX) return;
      // Capture only once it is really a drag, so taps still reach header buttons.
      state.active = true;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      sheetRef.current?.setAttribute('data-dragging', 'true');
    }
    const dt = Math.max(1, event.timeStamp - state.lastT);
    state.velocity = (event.clientY - state.lastY) / dt;
    state.lastY = event.clientY;
    state.lastT = event.timeStamp;
    paint(state.startH - delta);
  }, []);

  const finish = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    drag.current = null;
    if (!state || state.id !== event.pointerId || !state.active) return;
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    const height = state.startH - (event.clientY - state.startY);
    const next = nearestSnap(height, heightsRef.current, state.velocity);
    const sheet = sheetRef.current;
    if (sheet) {
      sheet.removeAttribute('data-dragging');
      sheet.style.transform = `translate3d(0, ${heightsRef.current.full - heightsRef.current[next]}px, 0)`;
    }
    onSnapChange(next);
  }, [onSnapChange]);

  // Keep the resting transform in step with live heights (resize, rotation, keyboard).
  useEffect(() => {
    if (drag.current?.active) return;
    const sheet = sheetRef.current;
    if (sheet) sheet.style.transform = restTransform;
  }, [restTransform]);

  const cycle = () => {
    if (suppressClick.current) return;
    onSnapChange(snap === 'peek' ? 'half' : snap === 'half' ? 'full' : 'half');
  };

  const hiddenBelow = heights.full - heights[snap];
  const contentStyle: CSSProperties = {
    overflowY: snap === 'peek' ? 'hidden' : 'auto',
    paddingBottom: `calc(${hiddenBelow + bottomPadding}px + env(safe-area-inset-bottom, 0px) + 16px)`,
  };

  return (
    <div
      ref={sheetRef}
      role="region"
      aria-label="Houses to fund"
      data-testid="fv3-sheet"
      data-snap={snap}
      className={cn(
        'fv3-sheet absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-[28px] bg-background shadow-[0_-6px_28px_hsl(var(--foreground)/0.14)]',
        centred && 'mx-auto w-full max-w-[720px]',
      )}
      style={{ height: heights.full, transform: restTransform }}
    >
      <div
        className="flex-none touch-none select-none"
        data-testid="fv3-sheet-drag"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        <button
          type="button"
          onClick={cycle}
          className="flex h-6 w-full cursor-grab items-center justify-center active:cursor-grabbing"
          aria-label={snap === 'full' ? 'Show more map' : 'Show more houses'}
        >
          <span className="h-1.5 w-10 rounded-full bg-muted-foreground/35" aria-hidden />
        </button>
        <div className="px-4 pb-2">{header}</div>
      </div>

      <div
        ref={contentRef}
        data-testid="fv3-sheet-content"
        className="min-h-0 flex-1 overscroll-contain px-4 pt-1 [scrollbar-gutter:stable]"
        style={contentStyle}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}

export default FunderV3Sheet;
