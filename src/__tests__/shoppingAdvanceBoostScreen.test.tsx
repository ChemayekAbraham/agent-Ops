import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ShoppingAdvanceBoostScreen } from '@/components/wallet/ShoppingAdvanceBoostScreen';

/**
 * The post-send notice is message-only, but two things on it must stay in step:
 * the 39-second display timer and the progress bar that visualises it. If the
 * bar stops tracking the timer it lies about how long is left.
 */
const TOTAL = 39;

async function advance(seconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(seconds * 1000);
  });
}

describe('ShoppingAdvanceBoostScreen display timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down from 39 seconds and closes on its own', async () => {
    const onClose = vi.fn();
    render(<ShoppingAdvanceBoostScreen amountSent={10_000} onClose={onClose} />);

    expect(screen.getByText('UGX 20,000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue \(39s\)/i })).toBeInTheDocument();

    await advance(13);
    expect(screen.getByRole('button', { name: /continue \(26s\)/i })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await advance(26);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a progress bar that tracks the remaining display time', async () => {
    const onClose = vi.fn();
    render(<ShoppingAdvanceBoostScreen amountSent={5_000} onClose={onClose} />);

    const bar = screen.getByRole('progressbar', {
      name: /time remaining before this message closes/i,
    });
    const fill = bar.firstElementChild as HTMLElement;

    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', String(TOTAL));
    expect(bar).toHaveAttribute('aria-valuenow', String(TOTAL));
    expect(bar).toHaveAttribute('aria-valuetext', '39 of 39 seconds remaining');
    expect(fill.style.width).toBe('100%');

    await advance(13);
    expect(bar).toHaveAttribute('aria-valuenow', '26');
    expect(bar).toHaveAttribute('aria-valuetext', '26 of 39 seconds remaining');
    expect(fill.style.width).toBe(`${(26 / TOTAL) * 100}%`);

    await advance(25);
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(fill.style.width).toBe(`${(1 / TOTAL) * 100}%`);

    await advance(1);
    expect(fill.style.width).toBe('0%');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('announces the remaining display time to screen readers', async () => {
    // A progressbar is not a live region, so the spoken figure lives in a
    // separate status element. It must track the timer, and must not fire
    // every single second.
    const onClose = vi.fn();
    render(<ShoppingAdvanceBoostScreen amountSent={2_000} onClose={onClose} />);

    const status = screen.getByRole('status');
    expect(status).toHaveClass('sr-only');
    expect(status).toHaveTextContent('This message closes in 39 seconds.');

    await advance(9);
    expect(status).toHaveTextContent('This message closes in 30 seconds.');

    await advance(1);
    // 29s is not an announce point: the last figure stands, nothing new fires.
    expect(status).toHaveTextContent('This message closes in 30 seconds.');

    await advance(24);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '5');
    expect(status).toHaveTextContent('This message closes in 5 seconds.');

    await advance(4);
    expect(status).toHaveTextContent('This message closes in 1 second.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stops the countdown and progress bar when closed early', async () => {
    // Mirrors the real parent: closing sets amountSent back to null, which
    // unmounts the notice and must clear the running interval.
    function Harness({ onClose }: { onClose: () => void }) {
      const [amountSent, setAmountSent] = useState<number | null>(10_000);
      return (
        <ShoppingAdvanceBoostScreen
          amountSent={amountSent}
          onClose={() => {
            onClose();
            setAmountSent(null);
          }}
        />
      );
    }

    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await advance(10);
    const bar = screen.getByRole('progressbar', {
      name: /time remaining before this message closes/i,
    });
    expect(bar).toHaveAttribute('aria-valuenow', '29');

    // Close early via the Continue button.
    fireEvent.click(screen.getByRole('button', { name: /continue \(29s\)/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // The notice is gone and the timer is dead: more elapsed time changes
    // nothing and never fires onClose again (no late re-close at 39s).
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    await advance(TOTAL * 1000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
