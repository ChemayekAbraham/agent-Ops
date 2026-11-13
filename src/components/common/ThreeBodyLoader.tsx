import { useMemo } from 'react';

interface ThreeBodyLoaderProps {
  /** Size in px. Defaults to 35. */
  size?: number;
  /** Animation cycle in seconds. Defaults to the CSS value (1.4s; 2.4s when the phone asks for less motion). */
  speed?: number;
  className?: string;
}

/** True when the phone or the app asks for less motion (the CSS then uses the slower 2.4s cycle). */
function wantsLessMotion(): boolean {
  try {
    const html = document.documentElement.classList;
    return html.contains('lite-mode') || html.contains('reduce-motion')
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/**
 * Three-body orbiting-dots loader. Pure CSS (styles live in index.css).
 *
 * Startup shows several loader screens one after another (page, sign-in, dashboard). Each is a
 * new element, so its animation would restart from zero and the dots would visibly jump. A
 * negative delay taken from the clock (--uib-offset) puts every loader at the same point of the
 * same cycle, so the spin carries on smoothly across those hand-overs.
 */
export default function ThreeBodyLoader({ size = 35, speed, className }: ThreeBodyLoaderProps) {
  const offset = useMemo(() => {
    const cycle = speed ?? (wantsLessMotion() ? 2.4 : 1.4);
    // The spin lasts 2.5 cycles and each wobble 1 cycle; 5 cycles is a whole number of both.
    const periodMs = cycle * 5 * 1000;
    return `${-(Date.now() % periodMs)}ms`;
  }, [speed]);

  return (
    <div
      className={`three-body${className ? ` ${className}` : ''}`}
      style={{
        ['--uib-size' as string]: `${size}px`,
        ['--uib-offset' as string]: offset,
        ...(speed ? { ['--uib-speed' as string]: `${speed}s` } : {}),
      }}
      role="status"
      aria-label="Loading"
    >
      <div className="three-body__dot" />
      <div className="three-body__dot" />
      <div className="three-body__dot" />
    </div>
  );
}
