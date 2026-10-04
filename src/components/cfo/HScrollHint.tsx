import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// Shared props that make a sticky column header keyboard-focusable.
// Tab/Shift+Tab cycles between headers; focusing one scrolls it into the
// visible column viewport without jumping the page vertically.
export const FOCUSABLE_COL_HEAD_CLASS =
  'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:rounded-sm';

// Find the nearest horizontally-scrollable ancestor (overflow-x auto/scroll).
export function findHScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el?.parentElement ?? null;
  while (node) {
    const style = window.getComputedStyle(node);
    const ox = style.overflowX;
    if ((ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth) return node;
    node = node.parentElement;
  }
  return null;
}

// Align the focused column header into the visible viewport of its scroll
// container with a small left/right gutter so adjacent columns stay hinted.
// Avoids the browser's default vertical jump that `scrollIntoView` causes.
export const focusableColHeadProps = {
  tabIndex: 0,
  onFocus: (e: React.FocusEvent<HTMLTableCellElement>) => {
    const th = e.currentTarget;
    const scroller = findHScrollParent(th);
    if (!scroller) return;
    const GUTTER = 24;
    const thRect = th.getBoundingClientRect();
    const scRect = scroller.getBoundingClientRect();
    const relLeft = thRect.left - scRect.left + scroller.scrollLeft;
    const relRight = relLeft + th.offsetWidth;
    const viewLeft = scroller.scrollLeft;
    const viewRight = viewLeft + scroller.clientWidth;
    let target = viewLeft;
    if (relLeft < viewLeft + GUTTER) {
      target = Math.max(0, relLeft - GUTTER);
    } else if (relRight > viewRight - GUTTER) {
      target = relRight - scroller.clientWidth + GUTTER;
    } else {
      return;
    }
    scroller.scrollTo({ left: target, behavior: 'smooth' });
  },
};

// ─────────────────────────────────────────────────────────────
// HScrollHint — wraps a horizontally scrollable region with subtle
// gradient edges, mobile tap-to-scroll buttons, keyboard arrow-key
// navigation, and a polite live region announcing which column range
// is currently visible.
// ─────────────────────────────────────────────────────────────
export function HScrollHint({
  children,
  className,
  ariaLabel,
}: {
  children: React.ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  const [visibleColsMsg, setVisibleColsMsg] = useState('');
  const lastMsgRef = useRef('');
  const announceTimerRef = useRef<number | null>(null);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setAtStart(scrollLeft <= 2);
    setAtEnd(scrollLeft + clientWidth >= scrollWidth - 2);
  }, []);

  const computeVisibleColumns = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const ths = Array.from(el.querySelectorAll<HTMLTableCellElement>('thead th'));
    if (ths.length === 0) return;
    const viewLeft = el.scrollLeft;
    const viewRight = viewLeft + el.clientWidth;
    let first = -1,
      last = -1;
    ths.forEach((th, i) => {
      const left = th.offsetLeft;
      const right = left + th.offsetWidth;
      const visibleWidth = Math.max(0, Math.min(right, viewRight) - Math.max(left, viewLeft));
      if (visibleWidth >= Math.min(th.offsetWidth, 24) * 0.5) {
        if (first === -1) first = i;
        last = i;
      }
    });
    if (first === -1) return;
    const firstLabel = (ths[first].textContent || '').trim().replace(/\s+/g, ' ');
    const lastLabel = (ths[last].textContent || '').trim().replace(/\s+/g, ' ');
    const msg =
      first === last
        ? `Column ${first + 1} of ${ths.length} in view: ${firstLabel}`
        : `Columns ${first + 1} to ${last + 1} of ${ths.length} in view: ${firstLabel} through ${lastLabel}`;
    if (msg === lastMsgRef.current) return;
    lastMsgRef.current = msg;
    if (announceTimerRef.current) window.clearTimeout(announceTimerRef.current);
    announceTimerRef.current = window.setTimeout(() => setVisibleColsMsg(msg), 250);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    computeVisibleColumns();
    const onScroll = () => {
      update();
      computeVisibleColumns();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      update();
      computeVisibleColumns();
    });
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (announceTimerRef.current) window.clearTimeout(announceTimerRef.current);
    };
  }, [update, computeVisibleColumns]);

  const nudge = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.6), behavior: 'smooth' });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const step = Math.max(120, el.clientWidth * 0.6);
    const page = el.clientWidth * 0.9;
    let handled = true;
    switch (e.key) {
      case 'ArrowRight': el.scrollBy({ left: step, behavior: 'smooth' }); break;
      case 'ArrowLeft':  el.scrollBy({ left: -step, behavior: 'smooth' }); break;
      case 'PageDown':   el.scrollBy({ left: page, behavior: 'smooth' }); break;
      case 'PageUp':     el.scrollBy({ left: -page, behavior: 'smooth' }); break;
      case 'Home':       el.scrollTo({ left: 0, behavior: 'smooth' }); break;
      case 'End':        el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' }); break;
      default:           handled = false;
    }
    if (handled) e.preventDefault();
  };

  return (
    <div className="relative">
      <div
        ref={ref}
        className={cn(
          className,
          'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-[inherit]'
        )}
        role="region"
        aria-label={ariaLabel}
        aria-describedby="hscroll-kbd-hint"
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-testid="hscroll-hint"
      >
        {children}
      </div>
      <span id="hscroll-kbd-hint" className="sr-only">
        Use the left and right arrow keys to scroll columns. Press Home or End to jump to the first or last column.
      </span>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="hscroll-live"
      >
        {visibleColsMsg}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent transition-opacity duration-200',
          atStart ? 'opacity-0' : 'opacity-100'
        )}
      />
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent transition-opacity duration-200',
          atEnd ? 'opacity-0' : 'opacity-100'
        )}
      />
      <button
        type="button"
        onClick={() => nudge(-1)}
        aria-label="Scroll left to see earlier columns"
        className={cn(
          'sm:hidden absolute left-1 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-card/90 border border-border shadow-sm backdrop-blur flex items-center justify-center text-foreground transition-opacity duration-200',
          atStart ? 'opacity-0 pointer-events-none' : 'opacity-100'
        )}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => nudge(1)}
        aria-label="Scroll right to see more columns"
        className={cn(
          'sm:hidden absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-card/90 border border-border shadow-sm backdrop-blur flex items-center justify-center text-foreground transition-opacity duration-200',
          atEnd ? 'opacity-0 pointer-events-none' : 'opacity-100'
        )}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}