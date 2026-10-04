import { useEffect, useRef, useState } from 'react';
import { useCurrency } from '@/hooks/useCurrency';
import { useReducedMotion } from '@/hooks/useCombinedSettings';
import { cn } from '@/lib/utils';

interface AnimatedBalanceProps {
  value: number;
  className?: string;
  /** Duration of the count-up tween in ms. Default 550. */
  durationMs?: number;
}

/**
 * Balance display with a smooth count-up/down tween and a brief
 * credit/debit flash whenever the value changes. Respects
 * `prefers-reduced-motion` (snaps directly to the new value, no flash).
 */
export function AnimatedBalance({ value, className = '', durationMs = 550 }: AnimatedBalanceProps) {
  const { formatAmount, formatAmountCompact } = useCurrency();
  const { prefersReducedMotion } = useReducedMotion();

  const [display, setDisplay] = useState(value);
  const [flash, setFlash] = useState<'credit' | 'debit' | null>(null);
  const prevRef = useRef(value);
  const rafRef = useRef<number | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    if (from === to) return;

    // Direction flash — skip on very first paint (from 0 -> value on mount
    // is not a real change the user made) unless the ref was already set.
    if (from !== 0 || display !== 0) {
      setFlash(to > from ? 'credit' : 'debit');
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setFlash(null), 1400);
    }

    if (prefersReducedMotion) {
      setDisplay(to);
      prevRef.current = to;
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        prevRef.current = to;
      }
    };
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, durationMs, prefersReducedMotion]);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  const formatBalance = (amount: number) =>
    amount >= 1_000_000 ? formatAmountCompact(amount) : formatAmount(amount);

  return (
    <span
      className={cn(
        'inline-block tabular-nums rounded-md px-1 -mx-1 transition-shadow',
        flash === 'credit' && 'animate-wallet-flash-credit shadow-[0_0_16px_-2px_hsl(var(--success)/0.5)]',
        flash === 'debit' && 'animate-wallet-flash-debit shadow-[0_0_16px_-2px_hsl(var(--warning)/0.5)]',
        className,
      )}
    >
      {formatBalance(display)}
    </span>
  );
}
