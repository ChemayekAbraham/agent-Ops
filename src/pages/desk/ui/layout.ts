import type { CSSProperties } from 'react';

/**
 * Layout that must hold before index.css arrives.
 *
 * main.tsx loads critical.css (Tailwind's base) first and index.css (every
 * utility class) in the background after the app renders. Until it lands a
 * class like `flex gap-2 px-3 whitespace-nowrap` does nothing, so every kit
 * piece sets its display, gaps, padding and wrapping inline, as DeskTabs does.
 * Classes carry only colour, type and state, which can safely arrive late.
 */

/** A pill: one line, padded, rounded, with a hairline border. */
export function pillLayout(padX: number, padY: number, gap = 4): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap,
    whiteSpace: 'nowrap',
    paddingLeft: padX,
    paddingRight: padX,
    paddingTop: padY,
    paddingBottom: padY,
    borderWidth: 1,
    borderStyle: 'solid',
    borderRadius: 999,
  };
}

/** A wrapping row of pills or buttons. */
export function rowLayout(gap = 6): CSSProperties {
  return { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap };
}

/** A vertical stack. */
export function stackLayout(gap: number): CSSProperties {
  return { display: 'flex', flexDirection: 'column', gap, minWidth: 0 };
}
