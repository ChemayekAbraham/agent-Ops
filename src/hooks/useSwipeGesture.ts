import { useState, useRef, useCallback, TouchEvent } from 'react';

interface SwipeState {
  isSwiping: boolean;
  direction: 'left' | 'right' | null;
  offset: number;
}

interface UseSwipeGestureOptions {
  threshold?: number; // Minimum distance to trigger swipe
  maxSwipe?: number; // Maximum swipe distance
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}

export function useSwipeGesture({
  threshold = 50,
  maxSwipe = 100,
  onSwipeLeft,
  onSwipeRight,
}: UseSwipeGestureOptions = {}) {
  const [state, setState] = useState<SwipeState>({
    isSwiping: false,
    direction: null,
    offset: 0,
  });

  const startX = useRef<number>(0);
  const startY = useRef<number>(0);
  const isHorizontalSwipe = useRef<boolean | null>(null);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    isHorizontalSwipe.current = null;
    setState({ isSwiping: false, direction: null, offset: 0 });
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const diffX = currentX - startX.current;
    const diffY = currentY - startY.current;

    // Determine if horizontal swipe on first significant movement
    if (isHorizontalSwipe.current === null) {
      if (Math.abs(diffX) > 10 || Math.abs(diffY) > 10) {
        isHorizontalSwipe.current = Math.abs(diffX) > Math.abs(diffY);
      }
    }

    // Only handle horizontal swipes
    if (!isHorizontalSwipe.current) return;

    // Prevent vertical scrolling when swiping horizontally
    e.preventDefault();

    const direction = diffX > 0 ? 'right' : 'left';
    const offset = Math.min(Math.abs(diffX), maxSwipe) * (diffX > 0 ? 1 : -1);

    setState({
      isSwiping: true,
      direction,
      offset,
    });
  }, [maxSwipe]);

  const handleTouchEnd = useCallback(() => {
    const { offset, direction } = state;

    if (Math.abs(offset) >= threshold) {
      if (direction === 'left' && onSwipeLeft) {
        onSwipeLeft();
      } else if (direction === 'right' && onSwipeRight) {
        onSwipeRight();
      }
    }

    // Reset state
    setState({ isSwiping: false, direction: null, offset: 0 });
    isHorizontalSwipe.current = null;
  }, [state, threshold, onSwipeLeft, onSwipeRight]);

  const reset = useCallback(() => {
    setState({ isSwiping: false, direction: null, offset: 0 });
  }, []);

  return {
    ...state,
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
    reset,
  };
}
