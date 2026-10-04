import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { EntityDetailSheet } from './EntityDetailSheet';

// Force the full-screen mobile branch (fullScreen = fullScreenOnMobile && isMobile).
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
}));

function touch(x: number, y: number) {
  const list = [{ clientX: x, clientY: y }];
  return { touches: list, changedTouches: list } as unknown as TouchEventInit;
}

/**
 * Renders a real trigger button that opens the sheet, mirroring the
 * "View landlord profile" → EntityDetailSheet flow. The trigger is what
 * should regain focus after any dismissal.
 */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        View landlord profile
      </button>
      <EntityDetailSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Jane Landlord"
        subtitle="Sunrise Apartments"
        fullScreenOnMobile
      />
    </>
  );
}

describe('EntityDetailSheet — focus return after dismissal (full-screen mobile)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function openSheet() {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: /view landlord profile/i });
    trigger.focus();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    return { trigger, sheet: screen.getByRole('dialog') };
  }

  it('returns focus to the trigger after a swipe-down dismiss', async () => {
    const { trigger, sheet } = openSheet();

    fireEvent.touchStart(sheet, touch(50, 100));
    fireEvent.touchMove(sheet, touch(50, 320));
    fireEvent.touchEnd(sheet, touch(50, 320));

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('returns focus to the trigger after an Escape dismiss', async () => {
    const { trigger, sheet } = openSheet();

    fireEvent.keyDown(sheet, { key: 'Escape', code: 'Escape' });

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('returns focus to the trigger after the Close button dismiss', async () => {
    const { trigger } = openSheet();

    fireEvent.click(screen.getByRole('button', { name: /close profile/i }));

    await waitFor(() => expect(trigger).toHaveFocus());
  });
});