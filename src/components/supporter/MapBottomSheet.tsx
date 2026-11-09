import { useRef, useState, useCallback, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Google Maps–style draggable bottom sheet.
 *
 * Three snap points:
 *  • collapsed — shows only the drag handle + header (~72 px)
 *  • half      — ~45 vh, shows header + filter chips + first few cards
 *  • full      — ~92 vh, scrollable card list
 *
 * Drag up/down to switch between snap points.
 * When scrolled to top inside the sheet and dragging down → collapses.
 *
 * Smoothness: the sheet is always laid out at its full height and moved with a
 * CSS transform. Dragging writes the transform straight to the element on each
 * animation frame (no React re-render, no layout), so the GPU does the work and
 * the listing inside is never re-laid-out while a finger is moving it.
 */

const COLLAPSED_PX = 72;
const HALF_VH = 45;
const FULL_VH = 92;
const SNAP_TRANSITION = 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)';

type SnapPoint = 'collapsed' | 'half' | 'full';
export type MapPanelLayout = 'sheet' | 'side';

/** Desktop (≥ 1024px): the list docks on the left as a side panel instead of a bottom sheet. */
const SIDE_PANEL_QUERY = '(min-width: 1024px)';

function useSidePanelLayout(): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(SIDE_PANEL_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(SIDE_PANEL_QUERY);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return matches;
}

const fullHeightPx = () => Math.round((window.innerHeight * FULL_VH) / 100);

const snapToHeight = (s: SnapPoint): number => {
  const vh = window.innerHeight;
  switch (s) {
    case 'collapsed': return COLLAPSED_PX;
    case 'half': return Math.round((vh * HALF_VH) / 100);
    case 'full': return fullHeightPx();
  }
};

/** translateY that leaves `height` px of the (full height) sheet visible. */
const transformFor = (height: number) => `translate3d(0, ${Math.max(0, fullHeightPx() - height)}px, 0)`;

const resolveSnap = (height: number): SnapPoint => {
  const vh = window.innerHeight;
  const halfH = (vh * HALF_VH) / 100;
  const fullH = (vh * FULL_VH) / 100;
  if (height < (COLLAPSED_PX + halfH) / 2) return 'collapsed';
  if (height < (halfH + fullH) / 2) return 'half';
  return 'full';
};

export function MapBottomSheet({
  children,
  header,
  defaultSnap = 'half',
  snap: externalSnap,
  onSnapChange,
}: {
  children: ReactNode;
  /** Content rendered in the fixed header area (title, filter chips, etc.) */
  header?: ReactNode | ((props: { snap: SnapPoint; setSnap: (s: SnapPoint) => void; layout: MapPanelLayout }) => ReactNode);
  defaultSnap?: SnapPoint;
  snap?: SnapPoint;
  onSnapChange?: (snap: SnapPoint) => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [internalSnap, setInternalSnap] = useState<SnapPoint>(defaultSnap);
  const snap = externalSnap ?? internalSnap;
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const setSnap = useCallback((newSnap: SnapPoint | ((prev: SnapPoint) => SnapPoint)) => {
    setInternalSnap((prev) => {
      const resolved = typeof newSnap === 'function' ? newSnap(prev) : newSnap;
      onSnapChange?.(resolved);
      return resolved;
    });
  }, [onSnapChange]);

  // Drag state lives in refs: nothing here may trigger a React render mid-drag.
  const draggingRef = useRef(false);
  const justDraggedRef = useRef(false);
  const dragOffsetRef = useRef(0);
  const dragStartY = useRef(0);
  const frameRef = useRef<number | null>(null);
  const isScrolledToTop = useRef(true);

  const paintDrag = useCallback(() => {
    frameRef.current = null;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const height = Math.max(
      COLLAPSED_PX,
      Math.min(fullHeightPx(), snapToHeight(snapRef.current) - dragOffsetRef.current),
    );
    sheet.style.transition = 'none';
    sheet.style.transform = transformFor(height);
  }, []);

  const scheduleDragPaint = useCallback(() => {
    if (frameRef.current === null) frameRef.current = window.requestAnimationFrame(paintDrag);
  }, [paintDrag]);

  const beginDrag = useCallback((offset: number) => {
    draggingRef.current = true;
    justDraggedRef.current = true;
    dragOffsetRef.current = offset;
    scheduleDragPaint();
  }, [scheduleDragPaint]);

  const endDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const finalHeight = Math.max(COLLAPSED_PX, snapToHeight(snapRef.current) - dragOffsetRef.current);
    const next = resolveSnap(finalHeight);
    dragOffsetRef.current = 0;
    const sheet = sheetRef.current;
    if (sheet) {
      // Hand the element back to React's styles: animate to the snap point.
      sheet.style.transition = SNAP_TRANSITION;
      sheet.style.transform = transformFor(snapToHeight(next));
    }
    setSnap(next);
    // A drag ends with a click on the handle in some browsers; swallow that one.
    window.setTimeout(() => { justDraggedRef.current = false; }, 0);
  }, [setSnap]);

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
  }, []);

  // Touch handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const content = contentRef.current;
    isScrolledToTop.current = !content || content.scrollTop <= 0;
    dragStartY.current = e.touches[0].clientY;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const deltaY = e.touches[0].clientY - dragStartY.current;
    if (snapRef.current === 'full') {
      // Swiping up (deltaY <= 0) scrolls down into listings - let native scroll take over
      if (deltaY <= 0) return;
      // Swiping down (deltaY > 0) should only drag the sheet down if user has scrolled to top
      const content = contentRef.current;
      if (content && content.scrollTop > 0) return;
    }
    if (Math.abs(deltaY) > 8) beginDrag(deltaY);
  }, [beginDrag]);

  // Mouse handlers (desktop)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relY = e.clientY - rect.top;
    // Only the sheet's own handle area starts a drag. A press above the sheet
    // (e.g. on the floating search bar, which is a React child of the sheet) must
    // keep its default action, or the search box can never take focus.
    if (relY < 0 || relY > 40) return;
    e.preventDefault();
    dragStartY.current = e.clientY;

    const handleMouseMove = (ev: MouseEvent) => {
      const deltaY = ev.clientY - dragStartY.current;
      if (Math.abs(deltaY) > 8) beginDrag(deltaY);
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      endDrag();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [beginDrag, endDrag]);

  // Track scroll position
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const handler = () => { isScrolledToTop.current = content.scrollTop <= 0; };
    content.addEventListener('scroll', handler, { passive: true });
    return () => content.removeEventListener('scroll', handler);
  }, []);

  // Tap handle to cycle snap points
  const handleHandleTap = useCallback(() => {
    if (draggingRef.current || justDraggedRef.current) return;
    setSnap((s) => {
      if (s === 'collapsed') return 'half';
      if (s === 'half') return 'full';
      return 'half';
    });
  }, [setSnap]);

  // Desktop: tell the full screen map and its floating search to start right of
  // the panel (see funderNewMap.css), for as long as the panel is up.
  const sidePanel = useSidePanelLayout();
  useEffect(() => {
    if (!sidePanel) return;
    document.body.dataset.mapSidePanel = 'true';
    return () => { delete document.body.dataset.mapSidePanel; };
  }, [sidePanel]);

  if (sidePanel) {
    return createPortal(
      <aside
        role="region"
        aria-label="House listings panel"
        data-testid="map-side-panel"
        className="fixed inset-y-0 left-0 z-[80] flex flex-col border-r border-border/60 bg-background shadow-[4px_0_24px_rgba(0,0,0,0.08)]"
        style={{ width: 'var(--fn-side-panel-w, 420px)' }}
      >
        {header && (
          <div className="flex-none border-b border-border/50 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
            {typeof header === 'function' ? header({ snap, setSnap, layout: 'side' }) : header}
          </div>
        )}
        {/* The list scrolls natively with the wheel and trackpad; no snaps on desktop. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 [scrollbar-gutter:stable]">
          {children}
        </div>
      </aside>,
      document.body,
    );
  }

  const sheetContent = (
    <div
      ref={sheetRef}
      role="region"
      aria-label="House listings panel"
      className="fixed inset-x-0 bottom-0 z-[80] mx-auto flex w-full max-w-lg flex-col rounded-t-[28px] bg-background shadow-[0_-4px_24px_rgba(0,0,0,0.12)]"
      style={{
        height: fullHeightPx(),
        transform: transformFor(snapToHeight(snap)),
        transition: SNAP_TRANSITION,
        willChange: 'transform',
        touchAction: 'none',
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={endDrag}
      onMouseDown={handleMouseDown}
    >
      {/* Drag handle */}
      <button
        type="button"
        className="mx-auto flex w-full flex-col items-center pt-2.5 pb-1 cursor-grab active:cursor-grabbing touch-manipulation"
        onClick={handleHandleTap}
        aria-label={`${snap === 'collapsed' ? 'Expand' : 'Collapse'} house listings`}
      >
        <div className="h-1 w-8 rounded-full bg-muted-foreground/40 hover:bg-muted-foreground/55 transition-colors" />
      </button>

      {/* Header (title + chips + controls) */}
      {header && (
        <div className="flex-none px-4 pb-2">
          {typeof header === 'function' ? header({ snap, setSnap, layout: 'sheet' }) : header}
        </div>
      )}

      {/* Scrollable content */}
      <div
        ref={contentRef}
        className="flex-1 overflow-y-auto overscroll-contain px-4 pb-safe"
        style={{
          overflowY: snap === 'full' ? 'auto' : 'hidden',
          touchAction: snap === 'full' ? 'pan-y' : 'none',
        }}
      >
        {children}
      </div>
    </div>
  );

  // Portal to document.body so it renders above the expanded map
  return createPortal(sheetContent, document.body);
}
