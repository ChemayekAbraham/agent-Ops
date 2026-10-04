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
 */

const COLLAPSED_PX = 72;
const HALF_VH = 45;
const FULL_VH = 92;

type SnapPoint = 'collapsed' | 'half' | 'full';

export function MapBottomSheet({
  children,
  header,
  defaultSnap = 'half',
  snap: externalSnap,
  onSnapChange,
}: {
  children: ReactNode;
  /** Content rendered in the fixed header area (title, filter chips, etc.) */
  header?: ReactNode | ((props: { snap: SnapPoint; setSnap: (s: SnapPoint) => void }) => ReactNode);
  defaultSnap?: SnapPoint;
  snap?: SnapPoint;
  onSnapChange?: (snap: SnapPoint) => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [internalSnap, setInternalSnap] = useState<SnapPoint>(defaultSnap);
  const snap = externalSnap ?? internalSnap;

  const setSnap = useCallback((newSnap: SnapPoint | ((prev: SnapPoint) => SnapPoint)) => {
    setInternalSnap((prev) => {
      const resolved = typeof newSnap === 'function' ? newSnap(prev) : newSnap;
      onSnapChange?.(resolved);
      return resolved;
    });
  }, [onSnapChange]);

  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);

  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const isScrolledToTop = useRef(true);

  const snapToHeight = useCallback((s: SnapPoint): number => {
    const vh = window.innerHeight;
    switch (s) {
      case 'collapsed': return COLLAPSED_PX;
      case 'half': return Math.round(vh * HALF_VH / 100);
      case 'full': return Math.round(vh * FULL_VH / 100);
    }
  }, []);

  const currentHeight = isDragging
    ? Math.max(COLLAPSED_PX, Math.min(window.innerHeight * FULL_VH / 100, snapToHeight(snap) - dragOffset))
    : snapToHeight(snap);

  const resolveSnap = useCallback((height: number): SnapPoint => {
    const vh = window.innerHeight;
    const halfH = vh * HALF_VH / 100;
    const fullH = vh * FULL_VH / 100;
    if (height < (COLLAPSED_PX + halfH) / 2) return 'collapsed';
    if (height < (halfH + fullH) / 2) return 'half';
    return 'full';
  }, []);

  // Touch handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const content = contentRef.current;
    isScrolledToTop.current = !content || content.scrollTop <= 0;
    dragStartY.current = e.touches[0].clientY;
    dragStartHeight.current = snapToHeight(snap);
  }, [snap, snapToHeight]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const deltaY = e.touches[0].clientY - dragStartY.current;
    if (snap === 'full') {
      // Swiping up (deltaY <= 0) scrolls down into listings - let native scroll take over
      if (deltaY <= 0) return;
      // Swiping down (deltaY > 0) should only drag the sheet down if user has scrolled to top
      const content = contentRef.current;
      if (content && content.scrollTop > 0) return;
    }
    if (Math.abs(deltaY) > 8) {
      setIsDragging(true);
      setDragOffset(deltaY);
    }
  }, [snap]);

  const handleTouchEnd = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);
    const finalHeight = Math.max(COLLAPSED_PX, snapToHeight(snap) - dragOffset);
    setSnap(resolveSnap(finalHeight));
    setDragOffset(0);
  }, [isDragging, snap, dragOffset, snapToHeight, resolveSnap, setSnap]);

  // Mouse handlers (desktop)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relY = e.clientY - rect.top;
    if (relY > 40) return;
    e.preventDefault();
    dragStartY.current = e.clientY;
    dragStartHeight.current = snapToHeight(snap);
    const currentSnap = snap;

    const handleMouseMove = (ev: MouseEvent) => {
      const deltaY = ev.clientY - dragStartY.current;
      if (Math.abs(deltaY) > 8) {
        setIsDragging(true);
        setDragOffset(deltaY);
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      // Use a timeout to read the latest dragOffset via ref
      setIsDragging(false);
      setDragOffset((prev) => {
        const finalH = Math.max(COLLAPSED_PX, snapToHeight(currentSnap) - prev);
        setSnap(resolveSnap(finalH));
        return 0;
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [snap, snapToHeight, resolveSnap, setSnap]);

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
    if (isDragging) return;
    setSnap((s) => {
      if (s === 'collapsed') return 'half';
      if (s === 'half') return 'full';
      return 'half';
    });
  }, [isDragging, setSnap]);

  const sheetContent = (
    <div
      ref={sheetRef}
      role="region"
      aria-label="House listings panel"
      className="fixed inset-x-0 bottom-0 z-[80] flex flex-col rounded-t-2xl bg-background shadow-[0_-4px_24px_rgba(0,0,0,0.12)] border-t border-border/60"
      style={{
        height: currentHeight,
        transition: isDragging ? 'none' : 'height 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
        touchAction: 'none',
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onMouseDown={handleMouseDown}
    >
      {/* Drag handle */}
      <button
        type="button"
        className="mx-auto flex w-full flex-col items-center pt-2.5 pb-1 cursor-grab active:cursor-grabbing touch-manipulation"
        onClick={handleHandleTap}
        aria-label={`${snap === 'collapsed' ? 'Expand' : 'Collapse'} house listings`}
      >
        <div className="h-1.5 w-12 rounded-full bg-muted-foreground/35 hover:bg-muted-foreground/50 transition-colors" />
      </button>

      {/* Header (title + chips + controls) */}
      {header && (
        <div className="flex-none px-4 pb-2">
          {typeof header === 'function' ? header({ snap, setSnap }) : header}
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
