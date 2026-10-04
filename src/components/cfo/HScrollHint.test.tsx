import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { HScrollHint, FOCUSABLE_COL_HEAD_CLASS, focusableColHeadProps } from './HScrollHint';

// jsdom doesn't implement ResizeObserver — provide a no-op stub.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = RO;

function renderTable({ scrollWidth = 800, clientWidth = 400 }: { scrollWidth?: number; clientWidth?: number } = {}) {
  const utils = render(
    <HScrollHint className="overflow-x-auto" ariaLabel="Test table">
      <table>
        <thead>
          <tr>
            <th {...focusableColHeadProps} className={FOCUSABLE_COL_HEAD_CLASS}>Date</th>
            <th {...focusableColHeadProps} className={FOCUSABLE_COL_HEAD_CLASS}>Reference</th>
            <th {...focusableColHeadProps} className={FOCUSABLE_COL_HEAD_CLASS}>Who</th>
            <th {...focusableColHeadProps} className={FOCUSABLE_COL_HEAD_CLASS}>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>1</td><td>2</td><td>3</td><td>4</td></tr>
        </tbody>
      </table>
    </HScrollHint>,
  );
  const region = screen.getByTestId('hscroll-hint');
  // jsdom: stub layout metrics so scrollBy/scrollTo math has something to work with
  Object.defineProperty(region, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(region, 'clientWidth', { configurable: true, value: clientWidth });
  return { ...utils, region };
}

describe('HScrollHint accessibility contract', () => {
  beforeEach(() => {
    // Reset any layout shims
  });

  it('exposes a labelled, keyboard-reachable region with a screen-reader hint', () => {
    renderTable();
    const region = screen.getByRole('region', { name: /test table/i });
    expect(region).toHaveAttribute('tabIndex', '0');
    expect(region).toHaveAttribute('aria-describedby', 'hscroll-kbd-hint');
    expect(document.getElementById('hscroll-kbd-hint')).toHaveTextContent(/arrow keys/i);
  });

  it('renders a polite aria-live region for column announcements', () => {
    renderTable();
    const live = screen.getByTestId('hscroll-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveAttribute('aria-atomic', 'true');
    expect(live).toHaveAttribute('role', 'status');
  });

  it('keeps a visible focus ring class on the scroll region', () => {
    renderTable();
    const region = screen.getByTestId('hscroll-hint');
    expect(region.className).toMatch(/focus-visible:ring/);
  });

  it('responds to ArrowRight / ArrowLeft / Home / End by calling scroll APIs', () => {
    const { region } = renderTable({ scrollWidth: 1000, clientWidth: 400 });
    const scrollBy = vi.fn();
    const scrollTo = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (region as any).scrollBy = scrollBy;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (region as any).scrollTo = scrollTo;

    fireEvent.keyDown(region, { key: 'ArrowRight' });
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: expect.any(Number), behavior: 'smooth' }));
    expect(scrollBy.mock.calls[0][0].left).toBeGreaterThan(0);

    fireEvent.keyDown(region, { key: 'ArrowLeft' });
    expect(scrollBy.mock.calls[1][0].left).toBeLessThan(0);

    fireEvent.keyDown(region, { key: 'Home' });
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'smooth' });

    fireEvent.keyDown(region, { key: 'End' });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 1000, behavior: 'smooth' });
  });

  it('ignores unrelated keys without scrolling', () => {
    const { region } = renderTable();
    const scrollBy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (region as any).scrollBy = scrollBy;
    fireEvent.keyDown(region, { key: 'a' });
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('marks every <th> as tabbable with a focus-ring class so Tab/Shift+Tab jumps between columns', () => {
    renderTable();
    const ths = screen.getAllByRole('columnheader');
    expect(ths.length).toBeGreaterThan(0);
    for (const th of ths) {
      expect(th).toHaveAttribute('tabIndex', '0');
      expect(th.className).toMatch(/focus-visible:ring/);
    }
  });

  it('announces the visible column range after a scroll event (debounced)', async () => {
    vi.useFakeTimers();
    try {
      const { region } = renderTable({ scrollWidth: 800, clientWidth: 400 });
      // Give every header a stable offsetLeft/offsetWidth so the visibility math works
      const ths = region.querySelectorAll<HTMLTableCellElement>('thead th');
      ths.forEach((th, i) => {
        Object.defineProperty(th, 'offsetLeft', { configurable: true, value: i * 200 });
        Object.defineProperty(th, 'offsetWidth', { configurable: true, value: 200 });
      });
      // Simulate the user scrolling to the right
      Object.defineProperty(region, 'scrollLeft', { configurable: true, value: 200 });
      fireEvent.scroll(region);
      act(() => { vi.advanceTimersByTime(300); });
      const live = screen.getByTestId('hscroll-live');
      expect(live.textContent).toMatch(/Column/);
      expect(live.textContent).toMatch(/of 4/);
    } finally {
      vi.useRealTimers();
    }
  });
});