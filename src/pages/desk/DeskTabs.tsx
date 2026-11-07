import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { CALM, FOCUS, prefersReducedMotion } from './deskTheme';
import { Sheet } from './ui/Sheet';

/**
 * The desk tab bar across the top of every desk.
 *
 * One row that scrolls sideways rather than squeezing: every tab keeps its
 * full label (no wrapping, no shrinking), the scrollbar is hidden but the row
 * still scrolls by wheel, trackpad and touch, and the edge that has more tabs
 * behind it fades out. The active tab is scrolled into view on load and
 * whenever the desk changes.
 *
 * The layout itself (flex row, gap, nowrap, no shrink, padding, underline) is
 * set inline. The app loads its Tailwind utilities from index.css in the
 * background after first paint (see main.tsx), and until that file arrives
 * utility classes do nothing — which is exactly how the labels ran together
 * ("Command centreService CentreAgent Ops…"). Inline styles hold from the
 * first frame. `.desk-tabs` in index.css adds only the hidden scrollbar and
 * the edge fade.
 */

export type Fade = 'none' | 'start' | 'end' | 'both';

/** Which edges have tabs hidden past them. A pixel of slack absorbs sub-pixel scroll positions. */
export function fadeEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): Fade {
  const before = scrollLeft > 1;
  const after = scrollLeft + clientWidth < scrollWidth - 1;
  if (before && after) return 'both';
  if (before) return 'start';
  if (after) return 'end';
  return 'none';
}

/** The horizontal scroll that brings a tab fully into view, or null when it already is. */
export function scrollTargetFor(
  tabLeft: number,
  tabWidth: number,
  scrollLeft: number,
  clientWidth: number,
  pad = 44,
): number | null {
  if (tabLeft - pad < scrollLeft) return Math.max(0, tabLeft - pad);
  if (tabLeft + tabWidth + pad > scrollLeft + clientWidth) return tabLeft + tabWidth + pad - clientWidth;
  return null;
}

/** Layout classes every tab carries; also asserted by the tests. */
export const TAB_LAYOUT = 'desk-tab shrink-0 whitespace-nowrap px-3';

/** The row: one line, scrolls sideways, never squeezes its tabs. */
export const BAR_STYLE: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexWrap: 'nowrap',
  gap: 4,
  minWidth: 0,
  maxWidth: '100%',
  overflowX: 'auto',
  overflowY: 'hidden',
};

/** One tab: full label, never shrinks, its own underline. */
export function tabStyle(active: boolean): CSSProperties {
  return {
    flex: '0 0 auto',
    flexShrink: 0,
    whiteSpace: 'nowrap',
    paddingLeft: 12,
    paddingRight: 12,
    borderBottomStyle: 'solid',
    borderBottomWidth: 2,
    borderBottomColor: active ? 'hsl(var(--primary))' : 'transparent',
    marginBottom: -1,
  };
}

export function DeskTabs({
  desks,
  activeId,
  board,
}: {
  desks: { id: string; name: string }[];
  activeId: string;
  board: boolean;
}) {
  const navRef = useRef<HTMLElement | null>(null);
  const [fade, setFade] = useState<Fade>('none');
  const first = useRef(true);

  const measure = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    setFade(fadeEdges(el.scrollLeft, el.clientWidth, el.scrollWidth));
  }, []);

  // Keep the fade honest as the row scrolls or the window resizes.
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [measure, desks.length]);

  // Bring the active tab into view on load and on every desk change. The row
  // is scrolled directly, so the page itself never jumps.
  useEffect(() => {
    const el = navRef.current;
    const tab = el?.querySelector<HTMLElement>(`[data-desk-tab="${activeId}"]`);
    if (!el || !tab) return;
    // `.desk-tabs` is position: relative, so offsetLeft is measured from the row itself.
    const left = scrollTargetFor(tab.offsetLeft, tab.offsetWidth, el.scrollLeft, el.clientWidth);
    if (left !== null) {
      const smooth = !first.current && !prefersReducedMotion();
      if (typeof el.scrollTo === 'function') el.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
      else el.scrollLeft = left;
    }
    first.current = false;
    measure();
  }, [activeId, measure]);

  return (
    <nav
      ref={navRef}
      aria-label="Desks"
      data-fade={fade}
      style={BAR_STYLE}
      className="desk-tabs border-b border-[var(--desk-line-color)] pb-px"
    >
      {desks.map((d) => {
        const active = d.id === activeId;
        return (
          <Link
            key={d.id}
            to={`/desk/${d.id}${board ? '?board=1' : ''}`}
            data-desk-tab={d.id}
            aria-current={active ? 'page' : undefined}
            style={tabStyle(active)}
            className={`${TAB_LAYOUT} rounded-t py-2 ${board ? 'text-base' : 'text-sm'} border-b-2 -mb-px ${CALM} ${FOCUS} ${
              active
                ? 'border-[hsl(var(--primary))] text-foreground font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {d.name}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Below md the tab bar becomes one "Desk ▾" button that opens a sheet of the
 * desks this person may open. With a single desk there is nothing to switch
 * to, so only its name shows.
 */
export function DeskSwitcher({
  desks,
  activeId,
  board,
}: {
  desks: { id: string; name: string }[];
  activeId: string;
  board: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = desks.find((d) => d.id === activeId);
  const name = current?.name ?? 'Desk';

  if (desks.length <= 1) {
    return (
      <span className="truncate text-base font-semibold text-foreground" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-desk-name>
        {name}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Desk: ${name}. Switch desk`}
        onClick={() => setOpen(true)}
        className={`rounded-lg text-base font-semibold text-foreground ${CALM} ${FOCUS}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, minHeight: 44, maxWidth: '100%' }}
        data-desk-switcher
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" style={{ flexShrink: 0 }} aria-hidden />
      </button>
      {open && (
        <Sheet title="Switch desk" onClose={() => setOpen(false)}>
          <nav aria-label="Desks">
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: 0, padding: 0, listStyle: 'none' }}>
              {desks.map((d) => {
                const active = d.id === activeId;
                return (
                  <li key={d.id}>
                    <Link
                      to={`/desk/${d.id}${board ? '?board=1' : ''}`}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => setOpen(false)}
                      className={`rounded-xl text-base ${CALM} ${FOCUS} ${
                        active ? 'bg-[hsl(var(--primary)/0.14)] font-semibold text-foreground' : 'text-foreground hover:bg-[var(--desk-surface-hover)]'
                      }`}
                      style={{ display: 'flex', alignItems: 'center', minHeight: 48, padding: '10px 14px' }}
                    >
                      {d.name}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </Sheet>
      )}
    </>
  );
}

