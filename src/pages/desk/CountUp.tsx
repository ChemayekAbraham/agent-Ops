import { useEffect, useMemo, useRef, useState } from 'react';
import { prefersReducedMotion } from './deskTheme';

const DURATION = 300;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Counts from the previous value to the new one on each refresh.
 *
 * The raw number is animated and formatted every frame, never the formatted
 * string, so compact figures like "UGX 1.2M" stay correct mid-flight. Width is
 * reserved by an invisible copy of the longer of the two end states and the
 * moving figure is painted over it, so a refresh cannot shift the layout.
 */
export function CountUp({
  value,
  format,
  align = 'left',
  className = '',
}: {
  value: number;
  format: (n: number) => string;
  align?: 'left' | 'right';
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const displayRef = useRef(value);
  const frame = useRef(0);

  useEffect(() => {
    displayRef.current = display;
  }, [display]);

  useEffect(() => {
    const from = displayRef.current;
    if (from === value || !Number.isFinite(value)) {
      setDisplay(value);
      return;
    }
    if (prefersReducedMotion()) {
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      setDisplay(from + (value - from) * easeOut(t));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
    // `display` is deliberately not a dependency: it changes every frame.
  }, [value]);

  // Hold the wider of where we came from and where we are going.
  const reserve = useMemo(() => {
    const a = format(displayRef.current);
    const b = format(value);
    return a.length >= b.length ? a : b;
  }, [value, format]);

  return (
    <span className={`relative inline-block whitespace-nowrap tabular-nums ${className}`}>
      <span className="invisible" aria-hidden>
        {reserve}
      </span>
      <span className={`absolute top-0 ${align === 'right' ? 'right-0' : 'left-0'}`}>{format(display)}</span>
    </span>
  );
}
