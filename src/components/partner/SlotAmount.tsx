import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';

function SlotDigit({ digit, delay }: { digit: number; delay: number }) {
  return (
    <span className="relative inline-block h-[1.15em] w-[0.62em] overflow-hidden align-baseline">
      <span
        className="absolute left-0 top-0 flex flex-col transition-transform duration-700"
        style={{
          transform: `translateY(-${digit * 1.15}em)`,
          transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
          transitionDelay: `${delay}ms`,
        }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <span key={n} className="flex h-[1.15em] items-center justify-center leading-none">
            {n}
          </span>
        ))}
      </span>
    </span>
  );
}

/** Slot-machine style rolling amount. Digits cascade on every value change. */
export function SlotAmount({ value, className }: { value: number; className?: string }) {
  const text = formatDynamic(value);
  const prev = useRef(value);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 700);
      return () => clearTimeout(t);
    }
  }, [value]);

  const chars = text.split('');
  let digitIndex = 0;
  const digitCount = chars.filter((c) => /\d/.test(c)).length;

  return (
    <span
      className={cn(
        'inline-flex items-baseline tabular-nums transition-transform duration-300',
        pulse && 'scale-[1.04]',
        className,
      )}
    >
      {chars.map((ch, i) => {
        if (/\d/.test(ch)) {
          const delay = (digitCount - 1 - digitIndex) * 45;
          digitIndex += 1;
          return <SlotDigit key={i} digit={Number(ch)} delay={delay} />;
        }
        return (
          <span key={i} className={ch === ' ' ? 'mr-1 opacity-80' : ''}>
            {ch === ' ' ? '' : ch}
          </span>
        );
      })}
    </span>
  );
}
