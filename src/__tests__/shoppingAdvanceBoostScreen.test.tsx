import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
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
});
