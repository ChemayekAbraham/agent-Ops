import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useHorizontalSwipe } from '../useHorizontalSwipe';

type Pt = { clientX: number; clientY: number };

function fireSwipe(
  handlers: ReturnType<typeof useHorizontalSwipe>,
  start: Pt,
  end: Pt,
  durationMs = 100,
) {
  const t0 = 1_000_000;
  const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
  handlers.onTouchStart({ touches: [start] } as unknown as React.TouchEvent);
  nowSpy.mockReturnValue(t0 + durationMs);
  handlers.onTouchEnd({ changedTouches: [end] } as unknown as React.TouchEvent);
  nowSpy.mockRestore();
}

describe('useHorizontalSwipe', () => {
  it('fires onSwipeLeft when finger moves left past threshold', () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() =>
      useHorizontalSwipe({ onSwipeLeft, onSwipeRight }),
    );
    fireSwipe(result.current, { clientX: 200, clientY: 100 }, { clientX: 100, clientY: 105 });
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('fires onSwipeRight when finger moves right past threshold', () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() =>
      useHorizontalSwipe({ onSwipeLeft, onSwipeRight }),
    );
    fireSwipe(result.current, { clientX: 100, clientY: 100 }, { clientX: 200, clientY: 100 });
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it('ignores horizontal movement below the default 60px threshold', () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() =>
      useHorizontalSwipe({ onSwipeLeft, onSwipeRight }),
    );
    // 40px right — under threshold
    fireSwipe(result.current, { clientX: 100, clientY: 100 }, { clientX: 140, clientY: 100 });
    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('respects a custom threshold', () => {
    const onSwipeLeft = vi.fn();
    const { result } = renderHook(() =>
      useHorizontalSwipe({ onSwipeLeft, threshold: 150 }),
    );
    // 100px swipe — would trigger default but not custom 150 threshold
    fireSwipe(result.current, { clientX: 200, clientY: 100 }, { clientX: 100, clientY: 100 });
    expect(onSwipeLeft).not.toHaveBeenCalled();

    fireSwipe(result.current, { clientX: 250, clientY: 100 }, { clientX: 50, clientY: 100 });
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
  });

  it('ignores swipe when vertical drift exceeds maxVertical (scroll, not swipe)', () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() =>
      useHorizontalSwipe({ onSwipeLeft, onSwipeRight }),
    );
    // 100px horizontal + 80px vertical → treated as scroll
    fireSwipe(result.current, { clientX: 200, clientY: 100 }, { clientX: 100, clientY: 180 });
    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('honors a custom maxVertical tolerance', () => {
    const onSwipeLeft = vi.fn();
    const { result } = renderHook(() =>
      useHorizontalSwipe({ onSwipeLeft, maxVertical: 100 }),
    );
    fireSwipe(result.current, { clientX: 200, clientY: 100 }, { clientX: 100, clientY: 180 });
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
  });

  it('ignores gestures slower than 600ms (long-press / drift)', () => {
    const onSwipeLeft = vi.fn();
    const { result } = renderHook(() =>
      useHorizontalSwipe({ onSwipeLeft }),
    );
    fireSwipe(
      result.current,
      { clientX: 200, clientY: 100 },
      { clientX: 100, clientY: 100 },
      800,
    );
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it('does nothing when touchEnd fires without a matching touchStart', () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() =>
      useHorizontalSwipe({ onSwipeLeft, onSwipeRight }),
    );
    result.current.onTouchEnd({
      changedTouches: [{ clientX: 0, clientY: 0 }],
    } as unknown as React.TouchEvent);
    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('does not throw when matching callback is undefined', () => {
    const { result } = renderHook(() => useHorizontalSwipe({}));
    expect(() =>
      fireSwipe(result.current, { clientX: 200, clientY: 100 }, { clientX: 100, clientY: 100 }),
    ).not.toThrow();
  });
});