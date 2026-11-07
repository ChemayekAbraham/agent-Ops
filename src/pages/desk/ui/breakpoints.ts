import { useEffect, useState } from 'react';

/**
 * The desks' breakpoints — the one source. index.css repeats these numbers in
 * its `.desk-root` media queries (plain CSS has no custom media without a
 * PostCSS plugin this build does not run); `breakpoints.test` checks they agree.
 *
 *   xs   < 360       small phones
 *   sm   360 – 599   phones
 *   md   600 – 1023  large phones landscape, tablets
 *   lg   1024 – 1439 laptops
 *   xl   ≥ 1440      desktops
 *   wall ≥ 1920      Board mode on a wall
 */
export const BREAKPOINTS = { xs: 0, sm: 360, md: 600, lg: 1024, xl: 1440, wall: 1920 } as const;
export type Breakpoint = keyof typeof BREAKPOINTS;

const ORDER: Breakpoint[] = ['xs', 'sm', 'md', 'lg', 'xl', 'wall'];

/** Which band a width falls in. */
export function breakpointFor(width: number): Breakpoint {
  let bp: Breakpoint = 'xs';
  for (const b of ORDER) if (width >= BREAKPOINTS[b]) bp = b;
  return bp;
}

/** True when `bp` is at least `min` (e.g. atLeast('lg', 'md')). */
export function atLeast(bp: Breakpoint, min: Breakpoint): boolean {
  return ORDER.indexOf(bp) >= ORDER.indexOf(min);
}

const widthNow = () => (typeof window === 'undefined' ? BREAKPOINTS.lg : window.innerWidth);

/**
 * The current band, following the window. Starts from the real width on the
 * first render, so a phone never flashes the desktop header first.
 */
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() => breakpointFor(widthNow()));
  useEffect(() => {
    const on = () => setBp(breakpointFor(widthNow()));
    on();
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    // Media queries fire on a band change even where a resize event is missed
    // (device emulation, some in-app browsers).
    const queries =
      typeof window.matchMedia === 'function'
        ? ORDER.slice(1).map((b) => window.matchMedia(`(min-width: ${BREAKPOINTS[b]}px)`))
        : [];
    queries.forEach((q) => q.addEventListener?.('change', on));
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
      queries.forEach((q) => q.removeEventListener?.('change', on));
    };
  }, []);
  return bp;
}
