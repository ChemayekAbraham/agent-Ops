import { useState, useRef, useCallback, TouchEvent } from 'react';
import { hapticSuccess, hapticSelection, hapticImpact } from '@/lib/haptics';

interface UsePullToRefreshOptions {
  onRefresh: () => Promise<void>;
  threshold?: number;
  maxPull?: number;
}

interface PullToRefreshState {
  isPulling: boolean;
  isRefreshing: boolean;
  pullDistance: number;
  canRefresh: boolean;
}

const INTERACTIVE_SELECTORS = 'button, a, input, select, textarea, [role="tab"], [role="tablist"], [role="button"], [role="link"], [role="menuitem"], [data-radix-collection-item]';
const DRAG_START_THRESHOLD = 10; // px of vertical movement before entering pull mode

function isInteractiveElement(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  // Walk up to check if the touch target is inside an interactive element
  return el.closest(INTERACTIVE_SELECTORS) !== null;
}

export function usePullToRefresh({
  onRefresh,
  threshold = 80,
  maxPull = 120,
}: UsePullToRefreshOptions) {
  const [state, setState] = useState<PullToRefreshState>({
    isPulling: false,
    isRefreshing: false,
    pullDistance: 0,
    canRefresh: false,
  });

  const startY = useRef<number>(0);
  const currentY = useRef<number>(0);
  const isAtTop = useRef<boolean>(true);
  const hasTriggeredThresholdHaptic = useRef<boolean>(false);
  const touchOnInteractive = useRef<boolean>(false);
  const dragConfirmed = useRef<boolean>(false);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    // If touch starts on an interactive element, skip pull-to-refresh entirely
    if (isInteractiveElement(e.target)) {
      touchOnInteractive.current = true;
      return;
    }
    touchOnInteractive.current = false;
    dragConfirmed.current = false;

    // Determine "at top" from the actual page scroll position, not the wrapper's
    // scrollTop. The PullToRefresh wrapper grows with content and never scrolls
    // internally, so its scrollTop is always 0 — which made every downward drag
    // (anywhere on the page) hijack native scrolling. Read the real document
    // scroll offset instead.
    const scrollTop =
      window.scrollY ??
      document.scrollingElement?.scrollTop ??
      document.documentElement.scrollTop ??
      0;
    isAtTop.current = scrollTop <= 0;

    if (isAtTop.current && !state.isRefreshing) {
      startY.current = e.touches[0].clientY;
      hasTriggeredThresholdHaptic.current = false;
      // Don't set isPulling yet — wait for drag confirmation
    }
  }, [state.isRefreshing]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (touchOnInteractive.current || state.isRefreshing || !isAtTop.current) return;

    currentY.current = e.touches[0].clientY;
    const diff = currentY.current - startY.current;

    // Only allow pulling down
    if (diff < 0) {
      if (state.isPulling) {
        setState(prev => ({ ...prev, pullDistance: 0, canRefresh: false, isPulling: false }));
      }
      return;
    }

    // Require a minimum drag distance before activating pull mode
    if (!dragConfirmed.current) {
      if (diff < DRAG_START_THRESHOLD) return;
      dragConfirmed.current = true;
      // Reset startY so the visible pull starts from 0
      startY.current = currentY.current;
    }

    if (!state.isPulling) {
      setState(prev => ({ ...prev, isPulling: true }));
    }

    const resistance = 0.5;
    const pullDistance = Math.min((currentY.current - startY.current) * resistance, maxPull);
    const canRefresh = pullDistance >= threshold;

    if (canRefresh && !hasTriggeredThresholdHaptic.current) {
      hasTriggeredThresholdHaptic.current = true;
      hapticImpact();
    } else if (!canRefresh && hasTriggeredThresholdHaptic.current) {
      hasTriggeredThresholdHaptic.current = false;
    }

    setState(prev => ({
      ...prev,
      pullDistance,
      canRefresh,
    }));
  }, [state.isPulling, state.isRefreshing, threshold, maxPull]);

  const handleTouchEnd = useCallback(async () => {
    if (touchOnInteractive.current) {
      touchOnInteractive.current = false;
      return;
    }

    if (!state.isPulling) return;

    if (state.canRefresh && !state.isRefreshing) {
      hapticSelection();

      setState(prev => ({
        ...prev,
        isPulling: false,
        isRefreshing: true,
        pullDistance: threshold * 0.6,
      }));

      try {
        await onRefresh();
        hapticSuccess();
      } finally {
        setState({
          isPulling: false,
          isRefreshing: false,
          pullDistance: 0,
          canRefresh: false,
        });
      }
    } else {
      setState({
        isPulling: false,
        isRefreshing: false,
        pullDistance: 0,
        canRefresh: false,
      });
    }
  }, [state.isPulling, state.canRefresh, state.isRefreshing, threshold, onRefresh]);

  return {
    ...state,
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
    progress: Math.min((state.pullDistance / threshold) * 100, 100),
  };
}
