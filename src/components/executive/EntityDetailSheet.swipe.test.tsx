import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EntityDetailSheet } from './EntityDetailSheet';

// Force the full-screen mobile branch (fullScreen = fullScreenOnMobile && isMobile).
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
}));

/**
 * Helper to build a touch event init with a single touch point at (x, y).
 * React reads `touches` for start/move; the handlers don't rely on
 * changedTouches, but we include it for completeness.
 */
function touch(x: number, y: number) {
  const list = [{ clientX: x, clientY: y }];
  return { touches: list, changedTouches: list } as unknown as TouchEventInit;
}

describe('EntityDetailSheet — swipe-down to close (full-screen mobile)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderSheet(onClose: () => void) {
    render(
      <EntityDetailSheet
        open
        onClose={onClose}
        title="Jane Landlord"
        subtitle="Sunrise Apartments"
        fullScreenOnMobile
      />,
    );
    // The Radix sheet content is the dialog element carrying the touch handlers.
    return screen.getByRole('dialog');
  }

  it('closes when the user swipes down past the threshold', () => {
    const onClose = vi.fn();
    const sheet = renderSheet(onClose);

    // Drag from y=100 down to y=320 (Δ = 220px > 120px threshold).
    fireEvent.touchStart(sheet, touch(50, 100));
    fireEvent.touchMove(sheet, touch(50, 320));
    fireEvent.touchEnd(sheet, touch(50, 320));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT close on a small downward drag below the threshold', () => {
    const onClose = vi.fn();
    const sheet = renderSheet(onClose);

    // Δ = 40px — well under the 120px threshold.
    fireEvent.touchStart(sheet, touch(50, 100));
    fireEvent.touchMove(sheet, touch(50, 140));
    fireEvent.touchEnd(sheet, touch(50, 140));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does NOT close on an upward swipe', () => {
    const onClose = vi.fn();
    const sheet = renderSheet(onClose);

    // Dragging up should be ignored entirely.
    fireEvent.touchStart(sheet, touch(50, 300));
    fireEvent.touchMove(sheet, touch(50, 60));
    fireEvent.touchEnd(sheet, touch(50, 60));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does NOT close on a mostly-horizontal swipe', () => {
    const onClose = vi.fn();
    const sheet = renderSheet(onClose);

    // |Δx| (240) > |Δy| (60) → treated as horizontal, not a dismiss.
    fireEvent.touchStart(sheet, touch(50, 100));
    fireEvent.touchMove(sheet, touch(290, 160));
    fireEvent.touchEnd(sheet, touch(290, 160));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when the Escape key is pressed', () => {
    const onClose = vi.fn();
    const sheet = renderSheet(onClose);

    fireEvent.keyDown(sheet, { key: 'Escape', code: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the in-header Close button is tapped', () => {
    const onClose = vi.fn();
    renderSheet(onClose);

    fireEvent.click(screen.getByRole('button', { name: /close profile/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});